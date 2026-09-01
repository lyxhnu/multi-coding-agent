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
  `import { BUILTIN_SUBAGENT_PROMPTS } from "../builtin-agents/index.ts";`,
  `import { BUILTIN_SUBAGENT_PROMPTS } from "../builtin-agents/index.ts";
import { getMemoryDir } from "../config.ts";
import { MemoryStore } from "./memory/memory-store.ts";
import { createMemorySearchToolDefinition } from "./tools/memory-search.ts";
import { createMemoryGetToolDefinition } from "./tools/memory-get.ts";`,
  "memory imports",
);

// 2. config field
replaceOnce(
  `	/** Depth of *this* session in the subagent tree. 0 = root/user-facing session, 1 = a spawned subagent. Subagents at MAX_SUBAGENT_DEPTH cannot spawn further subagents: task/get_task_output/kill_task are physically removed from their tool registry. Default: 0. */
	subagentDepth?: number;
}`,
  `	/** Depth of *this* session in the subagent tree. 0 = root/user-facing session, 1 = a spawned subagent. Subagents at MAX_SUBAGENT_DEPTH cannot spawn further subagents: task/get_task_output/kill_task are physically removed from their tool registry. Default: 0. */
	subagentDepth?: number;
	/** Root directory for the Grok-aligned memory system (memory_search/memory_get + compaction memory flush). Default: getMemoryDir() (~/.pi/agent/memory). Tests should override this to a tmpdir. */
	memoryRootDir?: string;
}`,
  "config field: memoryRootDir",
);

// 3. private field
replaceOnce(
  `	private _subagentCoordinator!: SubagentCoordinator;`,
  `	private _subagentCoordinator!: SubagentCoordinator;
	private _memoryStore!: MemoryStore;`,
  "private field: _memoryStore",
);

// 4. constructor wiring
replaceOnce(
  `		this._subagentDepth = config.subagentDepth ?? 0;`,
  `		this._subagentDepth = config.subagentDepth ?? 0;
		this._memoryStore = new MemoryStore(config.memoryRootDir ?? getMemoryDir());`,
  "constructor: memoryStore",
);

fs.writeFileSync(path, content);
console.log("memory step 1-4 OK");
