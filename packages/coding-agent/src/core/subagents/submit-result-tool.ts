import type { ToolDefinition } from "../extensions/types.ts";
import { type SubagentSubmission, subagentSubmissionSchema } from "./protocol.ts";

export const SUBMIT_SUBAGENT_RESULT_TOOL_NAME = "submit_subagent_result";

export interface SubagentSubmissionChannel {
	definition: ToolDefinition;
	getSubmission: () => SubagentSubmission | undefined;
}

/** Creates the child-only terminal tool and its single-assignment result channel. */
export function createSubagentSubmissionChannel(): SubagentSubmissionChannel {
	let submission: SubagentSubmission | undefined;
	return {
		definition: {
			name: SUBMIT_SUBAGENT_RESULT_TOOL_NAME,
			label: SUBMIT_SUBAGENT_RESULT_TOOL_NAME,
			description:
				"Submit the final structured result for this delegated task. You must finish every task with exactly one call to this tool.",
			promptSnippet:
				"Finish by calling submit_subagent_result exactly once; ordinary assistant text is not a valid final result",
			parameters: subagentSubmissionSchema,
			async execute(_toolCallId, params) {
				const input = params as SubagentSubmission;
				if (submission) throw new Error("Subagent result was already submitted");
				submission = input;
				return {
					content: [{ type: "text", text: "Structured subagent result accepted." }],
					details: input,
					terminate: true,
				};
			},
		},
		getSubmission: () => submission,
	};
}
