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

// 5. register memory_search/memory_get alongside the other Grok-aligned tools.
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

// 6. default active tool names: add memory_search/memory_get (read-only, safe to expose by default).
replaceOnce(
  `					"enter_plan_mode",
					"exit_plan_mode",
					"task",
				];`,
  `					"enter_plan_mode",
					"exit_plan_mode",
					"task",
					"memory_search",
					"memory_get",
				];`,
  "defaultActiveToolNames: memory tools (depth 0)",
);
replaceOnce(
  `			: this._subagentDepth >= MAX_SUBAGENT_DEPTH
				? ["read", "bash", "edit", "write", "todo_write"]`,
  `			: this._subagentDepth >= MAX_SUBAGENT_DEPTH
				? ["read", "bash", "edit", "write", "todo_write", "memory_search", "memory_get"]`,
  "defaultActiveToolNames: memory tools (depth >= max)",
);

// 7. getter for tests / external inspection.
replaceOnce(
  `	get taskManager(): TaskManager {
		return this._taskManager;
	}`,
  `	get taskManager(): TaskManager {
		return this._taskManager;
	}

	get memoryStore(): MemoryStore {
		return this._memoryStore;
	}`,
  "memoryStore getter",
);

fs.writeFileSync(path, content);
console.log("memory step 5-7 OK");
