#!/usr/bin/env node
/**
 * Minimal fake LSP server for tests (see lsp-tool.test.ts): speaks just enough Content-Length framed
 * JSON-RPC to exercise LspManager without depending on a real language server binary. Deterministic,
 * canned responses per method so tests can assert on exact shapes.
 */

// Test-only crash simulation (see lsp-tool.test.ts's restart-limit case): when passed, this process
// exits right after replying to "initialize", simulating a server that crashes immediately on startup
// so LspManager's onClose/restart path (MAX_SERVER_RESTARTS) can be exercised deterministically.
const crashAfterInit = process.argv.includes("--crash-after-init");
// Optional side-channel: append one line per process spawn, so a test can count how many times
// LspManager (re)spawned this "server" without needing to race the async onClose/restart timing.
const spawnLogIndex = process.argv.indexOf("--spawn-log");
const spawnLogPath = spawnLogIndex !== -1 ? process.argv[spawnLogIndex + 1] : undefined;
if (spawnLogPath) {
	const { appendFileSync } = await import("node:fs");
	appendFileSync(spawnLogPath, `${process.pid}\n`);
}

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	for (;;) {
		const headerEnd = buffer.indexOf("\r\n\r\n");
		if (headerEnd === -1) return;
		const header = buffer.subarray(0, headerEnd).toString("utf8");
		const match = /Content-Length:\s*(\d+)/i.exec(header);
		if (!match) {
			buffer = buffer.subarray(headerEnd + 4);
			continue;
		}
		const length = Number.parseInt(match[1], 10);
		const bodyStart = headerEnd + 4;
		if (buffer.length < bodyStart + length) return;
		const body = buffer.subarray(bodyStart, bodyStart + length).toString("utf8");
		buffer = buffer.subarray(bodyStart + length);
		handle(JSON.parse(body));
	}
});

function send(message) {
	const json = JSON.stringify(message);
	process.stdout.write(`Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`);
}

function handle(message) {
	if (message.method === "initialize") {
		send({ jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
		if (crashAfterInit) process.exit(1);
		return;
	}
	if (message.method === "initialized" || message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
		return; // notifications: no response
	}
	if (message.method === "textDocument/definition") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: [{ uri: message.params.textDocument.uri, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }],
		});
		return;
	}
	if (message.method === "textDocument/references") {
		send({
			jsonrpc: "2.0",
			id: message.id,
			result: [{ uri: message.params.textDocument.uri, range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } }],
		});
		return;
	}
	if (message.method === "textDocument/hover") {
		send({ jsonrpc: "2.0", id: message.id, result: { contents: "fake hover text" } });
		return;
	}
	if (message.method === "textDocument/implementation") {
		send({ jsonrpc: "2.0", id: message.id, result: [] });
		return;
	}
	if (message.method === "textDocument/documentSymbol") {
		send({ jsonrpc: "2.0", id: message.id, result: [{ name: "fakeSymbol", kind: 12 }] });
		return;
	}
	if (message.method === "workspace/symbol") {
		send({ jsonrpc: "2.0", id: message.id, result: [{ name: `match:${message.params.query}`, kind: 12 }] });
		return;
	}
	if (message.method === "shutdown") {
		send({ jsonrpc: "2.0", id: message.id, result: null });
		return;
	}
	if (message.method === "exit") {
		process.exit(0);
	}
	if (message.id !== undefined) {
		send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
	}
}

process.on("SIGTERM", () => process.exit(0));
