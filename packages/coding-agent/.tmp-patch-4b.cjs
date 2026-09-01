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

const oldElse = `			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const compactResult = await compact(
					preparation,
					this.model,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					this.thinkingLevel,
					this.agent.streamFunction,
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason }),
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
			}`;

const newElse = `			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Grok-aligned two-pass compaction, pass 2: reuse a fresh speculative prefix summary (see
				// _maybeStartTwoPassPrefire) as customInstructions instead of summarizing the prefix cold.
				const prefire =
					policy.twoPassEnabled &&
					this._twoPassPrefire &&
					this._twoPassPrefire.capturedAtBranchLength === pathEntries.length
						? this._twoPassPrefire
						: undefined;
				this._twoPassPrefire = undefined;
				const mode: "single-pass" | "two-pass" = prefire ? "two-pass" : "single-pass";
				const customInstructions = prefire
					? \`A prior speculative pass already summarized the older prefix of this conversation as:\\n\\n\${prefire.summary}\\n\\nIncorporate it and focus your summary on the more recent tail.\`
					: undefined;

				// Grok-aligned wall-clock budget (default 300s): a generation exceeding it is retried once
				// with a fresh budget, then fails open (existing context is kept, nothing is lost).
				let compactResult: CompactionResult | undefined;
				for (let attempt = 0; attempt < 2; attempt++) {
					const budget = createWallClockBudgetSignal(
						this._autoCompactionAbortController.signal,
						policy.wallClockBudgetSecs,
					);
					try {
						compactResult = await compact(
							preparation,
							compactionModel,
							apiKey,
							headers,
							customInstructions,
							budget.signal,
							this.thinkingLevel,
							this.agent.streamFunction,
							env,
							this.settingsManager.getRetrySettings(),
							this._summarizationRetryCallbacks({ source: "compaction", reason }),
						);
						break;
					} catch (error) {
						const budgetHit = budget.signal.aborted && !this._autoCompactionAbortController.signal.aborted;
						if (budgetHit && attempt === 0) continue;
						if (budgetHit) break;
						throw error;
					} finally {
						budget.dispose();
					}
				}
				if (!compactResult) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: false,
						willRetry: false,
						errorMessage: \`Compaction exceeded its \${policy.wallClockBudgetSecs}s wall-clock budget twice; keeping the existing context.\`,
					});
					return false;
				}
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				// Grok-aligned memory flush (see CompactionPolicy.memoryFlushEnabled): the memory backend
				// itself lands in M5; until then this only records that a flush was requested but skipped,
				// per spec 9.6 ("flush failure must not block compaction").
				const grokDetails: CompactionEntryDetails = {
					policy,
					mode,
					memoryFlush: policy.memoryFlushEnabled
						? { attempted: true, written: 0, skipped: 0, warning: "memory backend not available yet (see M5)" }
						: { attempted: false, written: 0, skipped: 0 },
				};
				details = {
					...(compactResult.details as Record<string, unknown> | undefined),
					grokCompaction: grokDetails,
					compactModelWarning,
				};
			}`;

replaceOnce(oldElse, newElse, "compact() else-branch: two-pass + wall-clock budget + memoryFlush stub");

fs.writeFileSync(path, content);
console.log("step 4b OK");
