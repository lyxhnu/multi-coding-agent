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

// 4a. model resolution + auth: use the Grok-aligned compact_model instead of always this.model.
replaceOnce(
  `		try {
			if (!this.model) {
				return false;
			}

			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			let env: Record<string, string> | undefined;
			if (this.agent.streamFunction === streamSimple) {
				({ apiKey, headers, env } = await this._getRequiredRequestAuth(this.model));
			} else {
				({ apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model));
			}

			const pathEntries = this.sessionManager.getBranch();`,
  `		try {
			if (!this.model) {
				return false;
			}

			const policy = this.settingsManager.getCompactionPolicy();
			let compactionModel: Model<any> = this.model;
			let compactModelWarning: string | undefined;
			if (policy.compactModel) {
				const resolved = this._resolveCompactModel(policy.compactModel);
				if (resolved) {
					compactionModel = resolved;
				} else if (policy.strictCompactModel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: false,
						willRetry: false,
						errorMessage: \`compact_model "\${policy.compactModel}" could not be resolved and strictCompactModel is enabled; compaction was skipped.\`,
					});
					return false;
				} else {
					compactModelWarning = \`compact_model "\${policy.compactModel}" could not be resolved; fell back to the current model.\`;
				}
			}

			let apiKey: string | undefined;
			let headers: Record<string, string> | undefined;
			let env: Record<string, string> | undefined;
			if (this.agent.streamFunction === streamSimple) {
				({ apiKey, headers, env } = await this._getRequiredRequestAuth(compactionModel));
			} else {
				({ apiKey, headers, env } = await this._getSummarizationRequestAuth(compactionModel));
			}

			const pathEntries = this.sessionManager.getBranch();`,
  "compact_model resolution",
);

fs.writeFileSync(path, content);
console.log("step 4a OK");
