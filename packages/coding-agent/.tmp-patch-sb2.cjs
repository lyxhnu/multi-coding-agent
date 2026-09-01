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
  `			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: {
						commandPrefix: shellCommandPrefix,
						shellPath,
						taskManager: this._taskManager,
						...this.settingsManager.getBashBackgroundSettings(),
					},
					taskManager: this._taskManager,
					todoWrite: { store: this._todoStateStore },
				});`,
  `			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages },
					bash: {
						commandPrefix: shellCommandPrefix,
						shellPath,
						taskManager: this._taskManager,
						...this.settingsManager.getBashBackgroundSettings(),
						// Grok-aligned (spec 12): only subagents get an actual sandbox binding — read-only
						// capability_mode -> "read-only" profile, everything else -> "workspace". Root/user
						// sessions leave sandboxProfileOverride unset, so bash stays unsandboxed (unchanged).
						sandbox: this._sandboxProfileOverride
							? {
									manager: new SandboxManager({ workspaceRoot: this._cwd }),
									settings: resolveSandboxSettings({ profile: this._sandboxProfileOverride }),
								}
							: undefined,
					},
					taskManager: this._taskManager,
					todoWrite: { store: this._todoStateStore },
				});`,
  "_buildRuntime bash sandbox wiring",
);

fs.writeFileSync(path, content);
console.log("sandbox-subagent step 5 OK");
