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
  `			memory_search: createMemorySearchToolDefinition(this._memoryStore, this._cwd),
			memory_get: createMemoryGetToolDefinition(this._memoryStore),
		});`,
  `			memory_search: createMemorySearchToolDefinition(this._memoryStore, this._cwd),
			memory_get: createMemoryGetToolDefinition(this._memoryStore),
			lsp: createLspToolDefinition(this._lspManager),
		});`,
  "register lsp tool",
);

fs.writeFileSync(path, content);
console.log("lsp tool registration (retry) OK");
