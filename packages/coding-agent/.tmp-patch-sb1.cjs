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
  `import { createUnconfiguredWebSearchOperations, createWebSearchToolDefinition, type WebSearchOperations } from "./tools/web-search.ts";`,
  `import { createUnconfiguredWebSearchOperations, createWebSearchToolDefinition, type WebSearchOperations } from "./tools/web-search.ts";
import { SandboxManager } from "./sandbox/sandbox-manager.ts";
import { resolveSandboxSettings, type SandboxProfileName } from "./sandbox/types.ts";`,
  "sandbox imports",
);

// 2. config field: allow a caller (pi-child-runner.ts, for subagents) to force a sandbox profile for
// this session's own bash tool, per spec 12's "subagent read-only使用read-only profile,
// subagent writer使用workspace profile" rule. Root/user-facing sessions leave this unset, so their
// bash tool stays exactly as unsandboxed as before this feature existed (see M7 risk notes).
replaceOnce(
  `	/** MCP server configs. search_tool/use_tool only register when this is non-empty (Grok two-stage discovery, spec 13). */
	mcpServers?: McpServerConfig[];`,
  `	/** MCP server configs. search_tool/use_tool only register when this is non-empty (Grok two-stage discovery, spec 13). */
	mcpServers?: McpServerConfig[];
	/**
	 * Forces this session's own bash tool through SandboxManager with the given profile (spec 12).
	 * Used by SubagentCoordinator to bind a subagent's capability_mode to a sandbox profile
	 * ("read-only" capability_mode -> "read-only" sandbox profile; anything else -> "workspace").
	 * Root/user-facing sessions leave this unset (bash stays unsandboxed, unchanged default behavior).
	 */
	sandboxProfileOverride?: SandboxProfileName;`,
  "config field: sandboxProfileOverride",
);

// 3. private field
replaceOnce(
  `	private _webSearchOps!: WebSearchOperations;`,
  `	private _webSearchOps!: WebSearchOperations;
	private _sandboxProfileOverride: SandboxProfileName | undefined;`,
  "private field: _sandboxProfileOverride",
);

// 4. constructor wiring
replaceOnce(
  `		this._webSearchOps = config.webSearchOperations ?? createUnconfiguredWebSearchOperations();`,
  `		this._webSearchOps = config.webSearchOperations ?? createUnconfiguredWebSearchOperations();
		this._sandboxProfileOverride = config.sandboxProfileOverride;`,
  "constructor: sandboxProfileOverride",
);

fs.writeFileSync(path, content);
console.log("sandbox-subagent step 1-4 OK");
