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

const oldFlush = `				// Grok-aligned memory flush (see CompactionPolicy.memoryFlushEnabled): the memory backend
				// itself lands in M5; until then this only records that a flush was requested but skipped,
				// per spec 9.6 ("flush failure must not block compaction").
				const grokDetails: CompactionEntryDetails = {
					policy,
					mode,
					memoryFlush: policy.memoryFlushEnabled
						? { attempted: true, written: 0, skipped: 0, warning: "memory backend not available yet (see M5)" }
						: { attempted: false, written: 0, skipped: 0 },
				};`;

const newFlush = `				// Grok-aligned memory flush (see CompactionPolicy.memoryFlushEnabled, spec 9.6): write the
				// compaction summary itself into project memory (through the secret filter) before it is
				// dropped from the live context. Best-effort: failures never block compaction (fail-open).
				let memoryFlush: CompactionEntryDetails["memoryFlush"] = { attempted: false, written: 0, skipped: 0 };
				if (policy.memoryFlushEnabled) {
					try {
						const appendResult = this._memoryStore.appendProject(this._cwd, [summary]);
						memoryFlush = {
							attempted: true,
							written: appendResult.written,
							skipped: appendResult.skipped,
							warning: appendResult.warning,
						};
					} catch (flushError) {
						memoryFlush = {
							attempted: true,
							written: 0,
							skipped: 1,
							warning: \`memory flush failed: \${flushError instanceof Error ? flushError.message : String(flushError)}\`,
						};
					}
				}
				const grokDetails: CompactionEntryDetails = { policy, mode, memoryFlush };`;

replaceOnce(oldFlush, newFlush, "M4->M5 real memory flush wiring");

fs.writeFileSync(path, content);
console.log("memory flush wiring OK");
