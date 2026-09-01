from pathlib import Path
p = Path("packages/coding-agent/src/core/agent-session.ts")
s = p.read_text()

def once(a: str, b: str, label: str) -> None:
    global s
    n = s.count(a)
    if n != 1:
        raise SystemExit(f"{label}: expected 1, got {n}")
    s = s.replace(a, b, 1)
    print(label)

once(
    '\t\tif (await this._checkCompaction(msg)) {\n\t\t\treturn true;\n\t\t}',
    '\t\t// If the guard stopped a turn that was still issuing tool calls, a successful reduction must\n'
    '\t\t// continue the agent. Otherwise a threshold shake/compaction turns into a silent mid-action stop.\n'
    '\t\tif (await this._checkCompaction(msg, true, msg.stopReason === "toolUse")) {\n'
    '\t\t\treturn true;\n\t\t}',
    "post-run call",
)

once(
    '\t * @param assistantMessage The assistant message to check\n'
    '\t * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true\n'
    '\t */\n'
    '\tprivate async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {',
    '\t * @param assistantMessage The assistant message to check\n'
    '\t * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true\n'
    '\t * @param continueAfterReduction Whether a successful threshold reduction should resume the agent.\n'
    '\t * Use true only when the loop was stopped mid-action, e.g. a final assistant message with stopReason\n'
    '\t * "toolUse". A completed "stop" answer may be compacted for the next prompt but must not be\n'
    '\t * continued from an assistant message.\n'
    '\t */\n'
    '\tprivate async _checkCompaction(\n'
    '\t\tassistantMessage: AssistantMessage,\n'
    '\t\tskipAbortedCheck = true,\n'
    '\t\tcontinueAfterReduction = false,\n'
    '\t): Promise<boolean> {',
    "signature",
)

once(
    '\t\t\t\tif (\n'
    '\t\t\t\t\t!shouldCompact(remaining, contextWindow, settings) &&\n'
    '\t\t\t\t\t!needsRoomForOutput(remaining, contextWindow, maxTokens, policy)\n'
    '\t\t\t\t) {\n'
    '\t\t\t\t\treturn false;\n'
    '\t\t\t\t}\n'
    '\t\t\t}\n'
    '\t\t\treturn await this._runAutoCompaction("threshold", false);',
    '\t\t\t\tif (\n'
    '\t\t\t\t\t!shouldCompact(remaining, contextWindow, settings) &&\n'
    '\t\t\t\t\t!needsRoomForOutput(remaining, contextWindow, maxTokens, policy)\n'
    '\t\t\t\t) {\n'
    '\t\t\t\t\t// Shake did enough. If the guard stopped the loop while the model was still issuing tool\n'
    '\t\t\t\t\t// calls, resume from the freshly shaken context; otherwise just keep the smaller context\n'
    '\t\t\t\t\t// for the next user prompt. Returning false here for a toolUse turn is exactly the bug\n'
    '\t\t\t\t\t// that cut 10 benchmark tasks short after successful threshold shakes.\n'
    '\t\t\t\t\treturn continueAfterReduction;\n'
    '\t\t\t\t}\n'
    '\t\t\t}\n'
    '\t\t\treturn await this._runAutoCompaction("threshold", continueAfterReduction);',
    "threshold return",
)

if 'text.match(/^<skill name="([^"]+)" location="([^"]+)">\\n([\\s\\S]*?)\\n<\\/skill>' not in s:
    raise SystemExit("parseSkillBlock regex not intact")
p.write_text(s)
