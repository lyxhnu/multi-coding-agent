// Align the threshold-compaction trigger with the context guard's rule.
//
// The guard stops the loop using needsRoomForOutput (percentage threshold OR not enough free space for
// one more reply), but _checkCompaction only tested the percentage threshold. So a run sitting at 75% of
// the window with less than one reply of headroom got stopped by the guard and then told "nothing to do"
// by _checkCompaction, ending the run while the model was still issuing tool calls. Run
// 2026-08-18__00-33-41: 13 tasks died exactly that way, all with free space just under maxTokens * 1.2,
// and only 1 of the 13 passed.
const fs = require("node:fs");

const file = "packages/coding-agent/src/core/agent-session.ts";
let src = fs.readFileSync(file, "utf8");

const before = `		const policy = this.settingsManager.getCompactionPolicy();
		if (
			shouldCompact(contextTokens, contextWindow, settings) ||
			shouldAutoCompact(contextTokens, contextWindow, policy)
		) {`;

const after = `		const policy = this.settingsManager.getCompactionPolicy();
		// Must be the same rule _installContextGuard stops the loop for. When the guard used the
		// output-headroom rule and this only checked the percentage threshold, a context with room to
		// spare by percentage but no room for another reply got the loop stopped and then nothing done
		// about it, ending runs mid-action.
		const maxTokens = this.model?.maxTokens ?? 0;
		if (
			shouldCompact(contextTokens, contextWindow, settings) ||
			needsRoomForOutput(contextTokens, contextWindow, maxTokens, policy)
		) {`;

const beforeRecheck = `				if (
					!shouldCompact(remaining, contextWindow, settings) &&
					!shouldAutoCompact(remaining, contextWindow, policy)
				) {
					return false;
				}`;

const afterRecheck = `				if (
					!shouldCompact(remaining, contextWindow, settings) &&
					!needsRoomForOutput(remaining, contextWindow, maxTokens, policy)
				) {
					return false;
				}`;

for (const [find, replace, label] of [
  [before, after, "trigger"],
  [beforeRecheck, afterRecheck, "post-shake recheck"],
]) {
  const hits = src.split(find).length - 1;
  if (hits !== 1) {
    console.error("%s: expected 1 occurrence, found %d", label, hits);
    process.exit(1);
  }
  src = src.replace(find, replace);
  console.log("patched: %s", label);
}

fs.writeFileSync(file, src, "utf8");

// The regex in parseSkillBlock has been mangled by editing tools before; confirm it survived.
const ok = src.includes('text.match(/^<skill name="([^"]+)" location="([^"]+)">\\n([\\s\\S]*?)\\n<\\/skill>');
console.log("parseSkillBlock regex intact: %s", ok);
if (!ok) process.exit(1);
