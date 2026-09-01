import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import {
	BUILTIN_SUBAGENT_TYPES,
	type BuiltinSubagentType,
	type SubagentCapabilityMode,
} from "../../builtin-agents/index.ts";

const findingSchema = Type.Object(
	{
		summary: Type.String(),
		path: Type.Optional(Type.String()),
		line: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const changeSchema = Type.Object(
	{
		path: Type.String(),
		action: Type.Union([Type.Literal("created"), Type.Literal("modified"), Type.Literal("deleted")]),
		summary: Type.String(),
	},
	{ additionalProperties: false },
);

const verificationSchema = Type.Object(
	{
		command: Type.String(),
		status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("not_run")]),
		summary: Type.String(),
	},
	{ additionalProperties: false },
);

const completedSubmissionSchema = Type.Object(
	{
		status: Type.Literal("completed"),
		summary: Type.String(),
		findings: Type.Array(findingSchema),
		changes: Type.Array(changeSchema),
		verification: Type.Array(verificationSchema),
	},
	{ additionalProperties: false },
);

const blockedSubmissionSchema = Type.Object(
	{
		status: Type.Literal("blocked"),
		summary: Type.String(),
		blocker: Type.String(),
		findings: Type.Array(findingSchema),
	},
	{ additionalProperties: false },
);

export const subagentSubmissionSchema = Type.Union([completedSubmissionSchema, blockedSubmissionSchema]);

export type SubagentSubmission = Static<typeof subagentSubmissionSchema>;
export type CompletedSubagentSubmission = Static<typeof completedSubmissionSchema>;
export type BlockedSubagentSubmission = Static<typeof blockedSubmissionSchema>;

export interface SubagentTaskResult {
	agentType: BuiltinSubagentType;
	capabilityMode: SubagentCapabilityMode;
	isolation: "none" | "worktree";
	cwd: string;
	submission: SubagentSubmission;
}

export function isSubagentTaskResult(value: unknown): value is SubagentTaskResult {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<SubagentTaskResult>;
	return (
		BUILTIN_SUBAGENT_TYPES.some((agentType) => candidate.agentType === agentType) &&
		(candidate.capabilityMode === "read-only" ||
			candidate.capabilityMode === "read-write" ||
			candidate.capabilityMode === "execute" ||
			candidate.capabilityMode === "all") &&
		(candidate.isolation === "none" || candidate.isolation === "worktree") &&
		typeof candidate.cwd === "string" &&
		Value.Check(subagentSubmissionSchema, candidate.submission)
	);
}
