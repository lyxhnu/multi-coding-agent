/**
 * Minimal Content-Length framed JSON-RPC 2.0 client over a child process's stdio — the actual LSP wire
 * protocol (see https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#headerPart).
 * Deliberately dependency-free: this is the entire transport layer LspManager needs.
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

interface JsonRpcErrorShape {
	code: number;
	message: string;
}

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: JsonRpcErrorShape;
}

export class JsonRpcConnection {
	private readonly proc: ChildProcessWithoutNullStreams;
	private buffer: Buffer = Buffer.alloc(0);
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly notificationHandlers = new Map<string, (params: unknown) => void>();
	private closed = false;
	/** Set by the owner (LspManager) to react to unexpected process exit. */
	onClose: (() => void) | undefined;

	constructor(proc: ChildProcessWithoutNullStreams) {
		this.proc = proc;
		proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		// A server that crashes right after replying (see LspManager's restart-limit path) can have its
		// stdin pipe break before this process has processed the child's "exit" event, so a write() below
		// (e.g. the "initialized" notification sent immediately after the initialize response) can race an
		// EPIPE. Node reports that asynchronously as an "error" event on the stream; with no listener, an
		// unhandled one crashes the process. The "exit" handler below already reports/reacts to the process
		// going away, so this listener only needs to exist — not do anything — to prevent that.
		proc.stdin.on("error", () => undefined);
		proc.on("exit", () => {
			this.closed = true;
			for (const pending of this.pending.values()) pending.reject(new Error("LSP server process exited"));
			this.pending.clear();
			this.onClose?.();
		});
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		for (;;) {
			const headerEnd = this.buffer.indexOf("\r\n\r\n");
			if (headerEnd === -1) return;
			const header = this.buffer.subarray(0, headerEnd).toString("utf8");
			const match = /Content-Length:\s*(\d+)/i.exec(header);
			if (!match) {
				// Malformed header we can't frame-sync on; drop up to the separator and try again.
				this.buffer = this.buffer.subarray(headerEnd + 4);
				continue;
			}
			const length = Number.parseInt(match[1]!, 10);
			const bodyStart = headerEnd + 4;
			if (this.buffer.length < bodyStart + length) return; // wait for the rest of the body
			const body = this.buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
			this.buffer = this.buffer.subarray(bodyStart + length);
			this.handleMessage(body);
		}
	}

	private handleMessage(raw: string): void {
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(raw) as JsonRpcMessage;
		} catch {
			return;
		}
		if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error.message || "LSP request failed"));
			else pending.resolve(message.result);
		} else if (message.method) {
			this.notificationHandlers.get(message.method)?.(message.params);
		}
	}

	/** Sends a request and resolves with its result, or rejects on error/timeout/process exit. */
	request<T = unknown>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`LSP request "${method}" timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value as T);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	/** Sends a one-way notification (no response expected), e.g. textDocument/didOpen. */
	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	onNotification(method: string, handler: (params: unknown) => void): void {
		this.notificationHandlers.set(method, handler);
	}

	private write(message: unknown): void {
		if (this.closed) return;
		const json = JSON.stringify(message);
		const header = `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n`;
		this.proc.stdin.write(header + json);
	}

	dispose(): void {
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(new Error("LSP connection disposed"));
		this.pending.clear();
	}
}
