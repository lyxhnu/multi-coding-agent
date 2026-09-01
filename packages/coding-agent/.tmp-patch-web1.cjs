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
  `import { createLspToolDefinition } from "./tools/lsp.ts";`,
  `import { createLspToolDefinition } from "./tools/lsp.ts";
import { McpManager, type McpServerConfig } from "./mcp/mcp-manager.ts";
import { createMcpSearchToolDefinition } from "./tools/mcp-search-tool.ts";
import { createMcpUseToolDefinition } from "./tools/mcp-use-tool.ts";
import { createDefaultWebFetchOperations, createWebFetchToolDefinition, type WebFetchOperations } from "./tools/web-fetch.ts";
import { createUnconfiguredWebSearchOperations, createWebSearchToolDefinition, type WebSearchOperations } from "./tools/web-search.ts";`,
  "web/mcp imports",
);

// 2. config field
replaceOnce(
  `	/** Language server configs for the \`lsp\` tool. Default: DEFAULT_LSP_SERVERS (typescript-language-server). Servers are spawned lazily on first use. */
	lspServers?: LspServerConfig[];
}`,
  `	/** Language server configs for the \`lsp\` tool. Default: DEFAULT_LSP_SERVERS (typescript-language-server). Servers are spawned lazily on first use. */
	lspServers?: LspServerConfig[];
	/** MCP server configs. search_tool/use_tool only register when this is non-empty (Grok two-stage discovery, spec 13). */
	mcpServers?: McpServerConfig[];
	/** Overrides the default (no-op, "not configured") web_search backend. Wire a real provider (Brave/Bing/Tavily/...) here. */
	webSearchOperations?: WebSearchOperations;
	/** Overrides the default (real, fetch()-backed) web_fetch backend. */
	webFetchOperations?: WebFetchOperations;
}`,
  "config field: mcpServers/webSearchOperations/webFetchOperations",
);

fs.writeFileSync(path, content);
console.log("web/mcp step 1-2 OK");
