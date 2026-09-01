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

replaceOnce(
  `						"memory_search",
						"memory_get",
					];`,
  `						"memory_search",
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

replaceOnce(
  `			this._taskManager.cancelAll("session disposed");
		} catch {`,
  `			this._taskManager.cancelAll("session disposed");
			this._lspManager.disposeAll();
		} catch {`,
  "dispose: lspManager.disposeAll",
);

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
console.log("lsp step 6-8 OK");
