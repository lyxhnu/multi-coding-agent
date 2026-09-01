/**
 * Grok-aligned LSP integration (spec 11): lazily spawns one language server process per configured
 * language, keeps it registered with TaskManager (kind: "lsp") so it's visible/killable uniformly, tracks
 * per-file mtime to guard against stale server-side state (re-sends textDocument/didChange when the file
 * on disk has moved since it was opened), and restarts a crashed server up to twice before giving up.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { TaskManager } from "../tasks/task-manager.ts";
import { JsonRpcConnection } from "./jsonrpc-connection.ts";

export interface LspServerConfig {
	/** File extensions this server handles, e.g. [".ts", ".tsx"]. */
	extensions: string[];
	command: string;
	args?: string[];
	languageId: string;
}

/** A reasonable built-in default; override via LspManagerOptions.servers for other languages/toolchains. */
export const DEFAULT_LSP_SERVERS: LspServerConfig[] = [
	{
		extensions: [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"],
		command: "typescript-language-server",
		args: ["--stdio"],
		languageId: "typescript",
	},
];

const MAX_SERVER_RESTARTS = 2;
const INITIALIZE_TIMEOUT_MS = 15_000;

interface OpenDocument {
	version: number;
	mtimeMs: number;
}

interface ServerInstance {
	config: LspServerConfig;
	proc: ChildProcessWithoutNullStreams;
	connection: JsonRpcConnection;
	initialized: Promise<void>;
	openDocuments: Map<string, OpenDocument>;
	restarts: number;
	disposed: boolean;
}

export interface LspOperationError {
	code: "no_server_configured" | "spawn_failed" | "request_failed";
	message: string;
}

export interface LspManagerOptions {
	cwd: string;
	servers?: LspServerConfig[];
	taskManager?: TaskManager;
}

/**
 * Manages language server processes for the `lsp` tool. One instance per AgentSession (see
 * agent-session.ts); disposeAll() is called on session shutdown so no server outlives its session.
 */
export class LspManager {
	private readonly cwd: string;
	private readonly configs: LspServerConfig[];
	private readonly taskManager: TaskManager | undefined;
	private readonly servers = new Map<string, ServerInstance>();

	private async stopServer(instance: ServerInstance): Promise<void> {
		instance.disposed = true;
		instance.connection.dispose();
		if (instance.proc.stdout.closed && instance.proc.stderr.closed && instance.proc.stdin.closed) return;

		await new Promise<void>((resolveExit) => {
			const finish = () => {
				instance.proc.removeListener("close", finish);
				resolveExit();
			};
			instance.proc.once("close", finish);
			if (instance.proc.exitCode === null && instance.proc.signalCode === null) instance.proc.kill();
		});
	}

	constructor(options: LspManagerOptions) {
		this.cwd = options.cwd;
		this.configs = options.servers ?? DEFAULT_LSP_SERVERS;
		this.taskManager = options.taskManager;
	}

	private configFor(filePath: string): LspServerConfig | undefined {
		return this.configs.find((config) => config.extensions.some((ext) => filePath.endsWith(ext)));
	}

	private spawnServer(config: LspServerConfig): ServerInstance {
		const proc = spawn(config.command, config.args ?? [], { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
		proc.stderr.resume();
		const connection = new JsonRpcConnection(proc);
		const instance: ServerInstance = {
			config,
			proc,
			connection,
			openDocuments: new Map(),
			restarts: 0,
			disposed: false,
			initialized: Promise.resolve(),
		};

		instance.initialized = new Promise<void>((resolve, reject) => {
			const onSpawnError = (error: Error) => {
				reject(new Error(`Failed to start "${config.command}": ${error.message}`));
			};
			proc.once("error", onSpawnError);
			connection
				.request("initialize", {
					processId: process.pid,
					rootUri: pathToFileURL(this.cwd).toString(),
					capabilities: {},
				})
				.then(() => {
					connection.notify("initialized", {});
					proc.removeListener("error", onSpawnError);
					resolve();
				})
				.catch((error: unknown) => {
					proc.removeListener("error", onSpawnError);
					reject(error instanceof Error ? error : new Error(String(error)));
				});
		});
		// A restart-triggered replacement (see connection.onClose below) is never necessarily awaited by
		// any caller — the next real request just picks it up from this.servers later, and if *that*
		// replacement also fails to initialize (e.g. a server crash-looping on startup), its rejection
		// would otherwise surface as an unhandled promise rejection. This no-op subscriber doesn't
		// suppress the rejection for actual callers (they get their own independent .catch via awaiting
		// instance.initialized directly), it just guarantees at least one handler always exists.
		instance.initialized.catch(() => undefined);

		if (this.taskManager) {
			this.taskManager.start({
				kind: "lsp",
				cwd: this.cwd,
				description: `lsp server: ${config.command}`,
				run: (ctx) =>
					new Promise((resolve) => {
						const onAbort = () => {
							instance.disposed = true;
							instance.connection.dispose();
							proc.kill();
						};
						ctx.signal.addEventListener("abort", onAbort, { once: true });
						proc.once("exit", (code) => {
							ctx.signal.removeEventListener("abort", onAbort);
							resolve({ status: "completed", exitCode: code });
						});
					}),
			});
		}

		connection.onClose = () => {
			if (instance.disposed) return;
			if (instance.restarts >= MAX_SERVER_RESTARTS) {
				this.servers.delete(config.command);
				return;
			}
			const replacement = this.spawnServer(config);
			replacement.restarts = instance.restarts + 1;
			this.servers.set(config.command, replacement);
		};

		return instance;
	}

	private async getServer(filePath: string): Promise<ServerInstance> {
		const config = this.configFor(filePath);
		if (!config) {
			const error: LspOperationError = {
				code: "no_server_configured",
				message: `No language server is configured for "${filePath}".`,
			};
			throw error;
		}
		let instance = this.servers.get(config.command);
		if (!instance) {
			instance = this.spawnServer(config);
			this.servers.set(config.command, instance);
		}
		try {
			await withTimeout(instance.initialized, INITIALIZE_TIMEOUT_MS, `initializing "${config.command}"`);
		} catch (error) {
			this.servers.delete(instance.config.command);
			instance.disposed = true;
			instance.connection.dispose();
			instance.proc.kill();
			const opError: LspOperationError = {
				code: "spawn_failed",
				message: error instanceof Error ? error.message : String(error),
			};
			throw opError;
		}
		return instance;
	}

	/** Opens (or, if the file changed on disk since it was last opened, refreshes) a document. Guards against stale diagnostics (spec 11: "file generation/version 防 stale diagnostics"). */
	private ensureOpen(instance: ServerInstance, filePath: string): string {
		const uri = pathToFileURL(filePath).toString();
		const content = readFileSync(filePath, "utf-8");
		const mtimeMs = statSync(filePath).mtimeMs;
		const existing = instance.openDocuments.get(uri);
		if (!existing) {
			instance.connection.notify("textDocument/didOpen", {
				textDocument: { uri, languageId: instance.config.languageId, version: 1, text: content },
			});
			instance.openDocuments.set(uri, { version: 1, mtimeMs });
		} else if (existing.mtimeMs !== mtimeMs) {
			const version = existing.version + 1;
			instance.connection.notify("textDocument/didChange", {
				textDocument: { uri, version },
				contentChanges: [{ text: content }],
			});
			instance.openDocuments.set(uri, { version, mtimeMs });
		}
		return uri;
	}

	private async withDocument<T>(
		filePath: string,
		run: (instance: ServerInstance, uri: string) => Promise<T>,
	): Promise<T> {
		const resolvedFilePath = resolve(this.cwd, filePath);
		const instance = await this.getServer(resolvedFilePath);
		const uri = this.ensureOpen(instance, resolvedFilePath);
		try {
			return await run(instance, uri);
		} catch (error) {
			instance.disposed = true;
			instance.connection.dispose();
			instance.proc.kill();
			this.servers.delete(instance.config.command);
			const opError: LspOperationError = {
				code: "request_failed",
				message: error instanceof Error ? error.message : String(error),
			};
			throw opError;
		}
	}

	async goToDefinition(filePath: string, line: number, character: number): Promise<unknown> {
		return this.withDocument(filePath, (instance, uri) =>
			instance.connection.request("textDocument/definition", {
				textDocument: { uri },
				position: { line, character },
			}),
		);
	}

	async findReferences(filePath: string, line: number, character: number): Promise<unknown> {
		return this.withDocument(filePath, (instance, uri) =>
			instance.connection.request("textDocument/references", {
				textDocument: { uri },
				position: { line, character },
				context: { includeDeclaration: true },
			}),
		);
	}

	async hover(filePath: string, line: number, character: number): Promise<unknown> {
		return this.withDocument(filePath, (instance, uri) =>
			instance.connection.request("textDocument/hover", { textDocument: { uri }, position: { line, character } }),
		);
	}

	async goToImplementation(filePath: string, line: number, character: number): Promise<unknown> {
		return this.withDocument(filePath, (instance, uri) =>
			instance.connection.request("textDocument/implementation", {
				textDocument: { uri },
				position: { line, character },
			}),
		);
	}

	async documentSymbol(filePath: string): Promise<unknown> {
		return this.withDocument(filePath, (instance, uri) =>
			instance.connection.request("textDocument/documentSymbol", { textDocument: { uri } }),
		);
	}

	/** workspace/symbol isn't file-scoped; uses whichever server is already running, or the first configured one. */
	async workspaceSymbol(query: string): Promise<unknown> {
		const config = this.configs[0];
		if (!config) {
			const error: LspOperationError = {
				code: "no_server_configured",
				message: "No language servers are configured.",
			};
			throw error;
		}
		let instance = this.servers.get(config.command);
		if (!instance) {
			instance = this.spawnServer(config);
			this.servers.set(config.command, instance);
		}
		try {
			await withTimeout(instance.initialized, INITIALIZE_TIMEOUT_MS, `initializing "${config.command}"`);
			return await instance.connection.request("workspace/symbol", { query });
		} catch (error) {
			instance.disposed = true;
			instance.connection.dispose();
			instance.proc.kill();
			this.servers.delete(config.command);
			const opError: LspOperationError = {
				code: "request_failed",
				message: error instanceof Error ? error.message : String(error),
			};
			throw opError;
		}
	}

	/** Stops every managed server. Call on session shutdown. */
	async disposeAll(): Promise<void> {
		const instances = [...this.servers.values()];
		this.servers.clear();
		await Promise.all(instances.map((instance) => this.stopServer(instance)));
	}
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Timed out ${what} after ${timeoutMs}ms`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}
