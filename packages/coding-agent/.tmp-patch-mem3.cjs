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
  `				: [
						"read",
						"bash",
						"edit",
						"write",
						"todo_write",
						"get_task_output",
						"kill_task",
						"enter_plan_mode",
						"exit_plan_mode",
						"task",
					];`,
  `				: [
						"read",
						"bash",
						"edit",
						"write",
						"todo_write",
						"get_task_output",
						"kill_task",
						"enter_plan_mode",
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
console.log("memory step 6-7 OK");
