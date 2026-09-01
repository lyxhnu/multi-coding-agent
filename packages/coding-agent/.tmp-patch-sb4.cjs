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
  `						activeToolNames: this._capabilityModeToolNames(request.capabilityMode),
						systemPrompt: BUILTIN_SUBAGENT_PROMPTS[request.agentType],
						subagentDepth: this._subagentDepth + 1,
					},`,
  `						activeToolNames: this._capabilityModeToolNames(request.capabilityMode),
						systemPrompt: BUILTIN_SUBAGENT_PROMPTS[request.agentType],
						subagentDepth: this._subagentDepth + 1,
						// Grok-aligned (spec 12): read-only capability_mode gets the read-only sandbox
						// profile; read-write/execute/all (anything that can mutate) gets workspace.
						sandboxProfile: request.capabilityMode === "read-only" ? "read-only" : "workspace",
					},`,
  "runChild: sandboxProfile from capabilityMode",
);

fs.writeFileSync(path, content);
console.log("sandbox-subagent step 6 (retry) OK");
