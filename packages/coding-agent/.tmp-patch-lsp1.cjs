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

// 1. imports
replaceOnce(
  `import { createMemoryGetToolDefinition } from "./tools/memory-get.ts";`,
  `import { createMemoryGetToolDefinition } from "./tools/memory-get.ts";
import { LspManager, type LspServerConfig } from "./lsp/lsp-manager.ts";
import { createLspToolDefinition } from "./tools/lsp.ts";`,
  "lsp imports",
);

// 2. config field
replaceOnce(
  `	/** Root directory for the Grok-aligned memory system (memory_search/memory_get + compaction memory flush). Default: getMemoryDir() (~/.pi/agent/memory). Tests should override this to a tmpdir. */
	memoryRootDir?: string;
}`,
  `	/** Root directory for the Grok-aligned memory system (memory_search/memory_get + compaction memory flush). Default: getMemoryDir() (~/.pi/agent/memory). Tests should override this to a tmpdir. */
	memoryRootDir?: string;
	/** Language server configs for the \`lsp\` tool. Default: DEFAULT_LSP_SERVERS (typescript-language-server). Servers are spawned lazily on first use. */
	lspServers?: LspServerConfig[];
}`,
  "config field: lspServers",
);

// 3. private field
replaceOnce(
  `	private _memoryStore!: MemoryStore;`,
  `	private _memoryStore!: MemoryStore;
	private _lspManager!: LspManager;`,
  "private field: _lspManager",
);

// 4. constructor wiring
replaceOnce(
  `		this._memoryStore = new MemoryStore(config.memoryRootDir ?? getMemoryDir());`,
  `		this._memoryStore = new MemoryStore(config.memoryRootDir ?? getMemoryDir());
		this._lspManager = new LspManager({ cwd: this._cwd, servers: config.lspServers, taskManager: this._taskManager });`,
  "constructor: lspManager",
);

fs.writeFileSync(path, content);
console.log("lsp step 1-4 OK");
