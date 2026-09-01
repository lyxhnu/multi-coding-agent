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
  `	private _lspManager!: LspManager;`,
  `	private _lspManager!: LspManager;
	private _mcpManager!: McpManager;
	private _webFetchOps!: WebFetchOperations;
	private _webSearchOps!: WebSearchOperations;`,
  "private fields: mcp/web",
);

replaceOnce(
  `		this._lspManager = new LspManager({ cwd: this._cwd, servers: config.lspServers, taskManager: this._taskManager });`,
  `		this._lspManager = new LspManager({ cwd: this._cwd, servers: config.lspServers, taskManager: this._taskManager });
		this._mcpManager = new McpManager(config.mcpServers);
		this._webFetchOps = config.webFetchOperations ?? createDefaultWebFetchOperations();
		this._webSearchOps = config.webSearchOperations ?? createUnconfiguredWebSearchOperations();`,
  "constructor: mcp/web",
);

fs.writeFileSync(path, content);
console.log("web/mcp step 3-4 OK");
