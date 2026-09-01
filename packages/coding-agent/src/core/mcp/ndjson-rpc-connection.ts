/**
 * Minimal newline-delimited JSON-RPC 2.0 client over a child process's stdio — the wire format used by
 * MCP (Model Context Protocol) stdio servers (one JSON object per line, unlike LSP's Content-Length
 * framing; see jsonrpc-connection.ts for that variant).
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
}

export class NdjsonRpcConnection {
	private readonly proc: ChildProcessWithoutNullStreams;
	private buffer = "";
	private nextId = 1;
	private readonly pending = new Map<number, PendingRequest>();
	private closed = false;
	onClose: (() => void) | undefined;

	constructor(proc: ChildProcessWithoutNullStreams) {
		this.proc = proc;
		proc.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		proc.stdin.on("error", () => undefined);
		proc.on("exit", () => {
			this.closed = true;
			for (const pending of this.pending.values()) pending.reject(new Error("MCP server process exited"));
			this.pending.clear();
			this.onClose?.();
		});
	}

	private onData(chunk: Buffer): void {
		this.buffer += chunk.toString("utf8");
		let newlineIndex = this.buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = this.buffer.slice(0, newlineIndex).trim();
			this.buffer = this.buffer.slice(newlineIndex + 1);
			if (line) this.handleLine(line);
			newlineIndex = this.buffer.indexOf("\n");
		}
	}

	private handleLine(line: string): void {
		let message: { id?: number; result?: unknown; error?: { message: string } };
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (message.id === undefined) return;
		const pending = this.pending.get(message.id);
		if (!pending) return;
		this.pending.delete(message.id);
		if (message.error) pending.reject(new Error(message.error.message || "MCP request failed"));
		else pending.resolve(message.result);
	}

	request<T = unknown>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP request "${method}" timed out after ${timeoutMs}ms`));
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

	notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private write(message: unknown): void {
		if (this.closed) return;
		this.proc.stdin.write(`${JSON.stringify(message)}\n`);
	}

	dispose(): void {
		this.closed = true;
		for (const pending of this.pending.values()) pending.reject(new Error("MCP connection disposed"));
		this.pending.clear();
	}
}
