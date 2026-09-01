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

// 5. register the lsp tool alongside the other Grok-aligned tools.
replaceOnce(
  `			memory_search: createMemorySearchToolDefinition(this._memoryStore, this._cwd),
			memory_get: createMemoryGetToolDefinition(this._memoryStore),
		});`,
  `			memory_search: createMemorySearchToolDefinition(this._memoryStore, this._cwd),
			memory_get: createMemoryGetToolDefinition(this._memoryStore),
			lsp: createLspToolDefinition(this._lspManager),
		});`,
  "register lsp tool",
);

// 6. default active tool names: add "lsp" (depth 0 and depth >= max both get it; servers spawn lazily).
replaceOnce(
  `					"memory_search",
					"memory_get",
				];`,
  `					"memory_search",
					"memory_get",
					"lsp",
				];`,
  "defaultActiveToolNames: lsp (depth 0)",
);
replaceOnce(
  `				? ["read", "bash", "edit", "write", "todo_write", "memory_search", "memory_get"]`,
  `				? ["read", "bash", "edit", "write", "todo_write", "memory_search", "memory_get", "lsp"]`,
  "defaultActiveToolNames: lsp (depth >= max)",
);

// 7. dispose(): stop any spawned language servers.
replaceOnce(
  `			this._taskManager.cancelAll("session disposed");
		} catch {`,
  `			this._taskManager.cancelAll("session disposed");
			this._lspManager.disposeAll();
		} catch {`,
  "dispose: lspManager.disposeAll",
);

// 8. getter for tests / external inspection.
replaceOnce(
  `	get memoryStore(): MemoryStore {
		return this._memoryStore;
	}`,
  `	get memoryStore(): MemoryStore {
		return this._memoryStore;
	}

	get lspManager(): LspManager {
		return this._lspManager;
	}`,
  "lspManager getter",
);

fs.writeFileSync(path, content);
console.log("lsp step 5-8 OK");
