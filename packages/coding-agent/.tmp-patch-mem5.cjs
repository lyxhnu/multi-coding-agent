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
  `		Object.assign(baseToolDefinitions, {
			enter_plan_mode: createEnterPlanModeToolDefinition(this),
			exit_plan_mode: createExitPlanModeToolDefinition(this),
		});`,
  `		Object.assign(baseToolDefinitions, {
			enter_plan_mode: createEnterPlanModeToolDefinition(this),
			exit_plan_mode: createExitPlanModeToolDefinition(this),
			memory_search: createMemorySearchToolDefinition(this._memoryStore, this._cwd),
			memory_get: createMemoryGetToolDefinition(this._memoryStore),
		});`,
  "register memory tools",
);

fs.writeFileSync(path, content);
console.log("memory tool registration OK");
