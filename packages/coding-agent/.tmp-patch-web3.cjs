const fs = require("fs");
const path = "src/core/agent-session.ts";
let content = fs.readFileSync(path, "utf8");
function replaceOnce(oldStr, newStr, label) {
  if (!content.includes(oldStr)) throw new Error("anchor not found: " + label);
  const idx = content.indexOf(oldStr);
  const idx2 = content.indexOf(oldStr, idx + 1);
  if (idx2 !== -1) throw new Error("anchor not unique: " + label);
  content = content.replace(oldStr, newStr);
}

// 5. registration: web_fetch/web_search always; search_tool/use_tool only when MCP servers are configured.
replaceOnce(
  `			memory_search: createMemorySearchToolDefinition(this._memoryStore, this._cwd),
			memory_get: createMemoryGetToolDefinition(this._memoryStore),
			lsp: createLspToolDefinition(this._lspManager),
		});`,
  `			memory_search: createMemorySearchToolDefinition(this._memoryStore, this._cwd),
			memory_get: createMemoryGetToolDefinition(this._memoryStore),
			lsp: createLspToolDefinition(this._lspManager),
			web_fetch: createWebFetchToolDefinition(this._webFetchOps),
			web_search: createWebSearchToolDefinition(this._webSearchOps),
		});
		if (this._mcpManager.hasServers()) {
			Object.assign(baseToolDefinitions, {
				search_tool: createMcpSearchToolDefinition(this._mcpManager),
				use_tool: createMcpUseToolDefinition(this._mcpManager),
			});
		}`,
  "register web/mcp tools",
);

// 6. default active tool names.
replaceOnce(
  `				? ["read", "bash", "edit", "write", "todo_write", "memory_search", "memory_get", "lsp"]`,
  `				? ["read", "bash", "edit", "write", "todo_write", "memory_search", "memory_get", "lsp", "web_fetch", "web_search"]`,
  "defaultActiveToolNames: web (depth >= max)",
);
replaceOnce(
  `						"memory_search",
						"memory_get",
						"lsp",
					];`,
  `						"memory_search",
						"memory_get",
						"lsp",
						"web_fetch",
						"web_search",
					];
		if (!this._baseToolsOverride && this._mcpManager.hasServers()) {
			defaultActiveToolNames.push("search_tool", "use_tool");
		}`,
  "defaultActiveToolNames: web/mcp (depth 0)",
);

// 7. dispose(): stop any spawned MCP servers.
replaceOnce(
  `			this._lspManager.disposeAll();
		} catch {`,
  `			this._lspManager.disposeAll();
			this._mcpManager.disposeAll();
		} catch {`,
  "dispose: mcpManager.disposeAll",
);

// 8. getters.
replaceOnce(
  `	get lspManager(): LspManager {
		return this._lspManager;
	}`,
  `	get lspManager(): LspManager {
		return this._lspManager;
	}

	get mcpManager(): McpManager {
		return this._mcpManager;
	}`,
  "mcpManager getter",
);

fs.writeFileSync(path, content);
console.log("web/mcp step 5-8 OK");
