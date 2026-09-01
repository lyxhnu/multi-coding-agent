/**
 * Grok-aligned MCP integration (spec 13): manages configured MCP stdio servers and implements the
 * two-stage tool discovery pattern (search_tool / use_tool) so full tool schemas are never dumped into
 * the system prompt — only names + short descriptions are visible until the model actually searches.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { NdjsonRpcConnection } from "./ndjson-rpc-connection.ts";

export interface McpServerConfig {
	id: string;
	command: string;
	args?: string[];
}

export interface McpToolInfo {
	name: string;
	description?: string;
	inputSchema?: unknown;
}

export interface McpToolMatch extends McpToolInfo {
	serverId: string;
}

const INITIALIZE_TIMEOUT_MS = 15_000;

interface ServerConnection {
	config: McpServerConfig;
	proc: ChildProcessWithoutNullStreams;
	connection: NdjsonRpcConnection;
	initialized: Promise<void>;
	toolsCache: McpToolInfo[] | undefined;
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

/** Manages every configured MCP server for one AgentSession. Servers are spawned lazily, on first search/use. */
export class McpManager {
	private readonly configs: McpServerConfig[];
	private readonly connections = new Map<string, ServerConnection>();

	constructor(configs: McpServerConfig[] = []) {
		this.configs = configs;
	}

	private async stopConnection(entry: ServerConnection): Promise<void> {
		entry.connection.dispose();
		if (entry.proc.stdout.closed && entry.proc.stderr.closed && entry.proc.stdin.closed) return;
		await new Promise<void>((resolveExit) => {
			const finish = () => {
				entry.proc.removeListener("close", finish);
				resolveExit();
			};
			entry.proc.once("close", finish);
			if (entry.proc.exitCode === null && entry.proc.signalCode === null) entry.proc.kill();
		});
	}

	/** Whether any MCP server is configured — search_tool/use_tool only register when this is true (see agent-session.ts). */
	hasServers(): boolean {
		return this.configs.length > 0;
	}

	private connect(config: McpServerConfig): ServerConnection {
		const proc = spawn(config.command, config.args ?? [], { stdio: ["pipe", "pipe", "pipe"] });
		proc.stderr.resume();
		const connection = new NdjsonRpcConnection(proc);
		const entry: ServerConnection = {
			config,
			proc,
			connection,
			toolsCache: undefined,
			initialized: Promise.resolve(),
		};
		entry.initialized = new Promise<void>((resolve, reject) => {
			const onSpawnError = (error: Error) =>
				reject(new Error(`Failed to start MCP server "${config.id}" (${config.command}): ${error.message}`));
			proc.once("error", onSpawnError);
			connection
				.request("initialize", {
					protocolVersion: "2024-11-05",
					capabilities: {},
					clientInfo: { name: "pi", version: "1" },
				})
				.then(() => {
					connection.notify("notifications/initialized", {});
					proc.removeListener("error", onSpawnError);
					resolve();
				})
				.catch((error: unknown) => {
					proc.removeListener("error", onSpawnError);
					reject(error instanceof Error ? error : new Error(String(error)));
				});
		});
		return entry;
	}

	private async getConnection(serverId: string): Promise<ServerConnection> {
		const config = this.configs.find((c) => c.id === serverId);
		if (!config) throw new Error(`Unknown MCP server id "${serverId}".`);
		let entry = this.connections.get(serverId);
		if (!entry) {
			entry = this.connect(config);
			this.connections.set(serverId, entry);
		}
		try {
			await withTimeout(entry.initialized, INITIALIZE_TIMEOUT_MS, `initializing MCP server "${serverId}"`);
		} catch (error) {
			this.connections.delete(serverId);
			await this.stopConnection(entry);
			throw error;
		}
		return entry;
	}

	private async listTools(serverId: string): Promise<McpToolInfo[]> {
		const entry = await this.getConnection(serverId);
		if (entry.toolsCache) return entry.toolsCache;
		const result = await entry.connection.request<{ tools?: McpToolInfo[] }>("tools/list", {});
		entry.toolsCache = result.tools ?? [];
		return entry.toolsCache;
	}

	/** search_tool: substring match over every configured server's tool list. Returns full schemas only for matches. */
	async searchTools(query: string, limit = 10): Promise<McpToolMatch[]> {
		const q = query.toLowerCase();
		const matches: McpToolMatch[] = [];
		for (const config of this.configs) {
			let tools: McpToolInfo[];
			try {
				tools = await this.listTools(config.id);
			} catch {
				continue; // one broken server should not fail the whole search
			}
			for (const tool of tools) {
				const haystack = `${tool.name} ${tool.description ?? ""}`.toLowerCase();
				if (!q.trim() || haystack.includes(q)) matches.push({ serverId: config.id, ...tool });
				if (matches.length >= limit) return matches;
			}
		}
		return matches;
	}

	/** use_tool: invokes tools/call on the given server. */
	async useTool(serverId: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
		const entry = await this.getConnection(serverId);
		return entry.connection.request("tools/call", { name: toolName, arguments: args });
	}

	async disposeAll(): Promise<void> {
		const entries = [...this.connections.values()];
		this.connections.clear();
		await Promise.all(entries.map((entry) => this.stopConnection(entry)));
	}
}
