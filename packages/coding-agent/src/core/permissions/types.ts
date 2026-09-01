/**
 * Tool permission validation types.
 *
 * Aligned with Grok Build's `PermissionMode` (see xai-grok-agent/src/config.rs):
 * the same six modes, same wire names. `auto` (background classifier review) is
 * accepted but currently evaluated the same as `default` — no classifier backend
 * exists yet in pi.
 */
export type PermissionMode = "default" | "acceptEdits" | "auto" | "dontAsk" | "bypassPermissions" | "plan";

export const PERMISSION_MODES: readonly PermissionMode[] = [
	"default",
	"acceptEdits",
	"auto",
	"dontAsk",
	"bypassPermissions",
	"plan",
];

/** Final decision for a single tool call. */
export type PermissionDecision = "allow" | "ask" | "deny";

/** Where a decision came from, for audit and debugging. */
export type PermissionDecisionSource = "hard-deny" | "rule-deny" | "rule-allow" | "mode-policy" | "ask-fallback-deny";

/** A single allow/deny rule. `pattern` is matched against `${toolName}:${operation}` (see policy.ts). */
export interface PermissionRule {
	/** Glob-ish pattern, e.g. "bash:git status*", "edit:*", "bash:*". */
	pattern: string;
	/** Free-form note shown in audit logs / UI. */
	reason?: string;
}

export interface PermissionsSettings {
	mode?: PermissionMode; // default: "default"
	audit?: boolean; // default: true
	allow?: PermissionRule[];
	deny?: PermissionRule[];
}

export interface PermissionCheckInput {
	toolName: string;
	/** Validated, post-mutation tool arguments (same object guardToolCall receives). */
	args: unknown;
	mode: PermissionMode;
	allow?: PermissionRule[];
	deny?: PermissionRule[];
	/** Working directory, used for symlink-escape hard-deny checks on file tools. */
	cwd?: string;
}

export interface PermissionCheckResult {
	decision: PermissionDecision;
	source: PermissionDecisionSource;
	/** Human-readable reason, safe to show to the user and to persist in audit logs. */
	reason: string;
	/** Redacted, human-readable description of the operation (e.g. "bash: git status"). */
	operation: string;
}
