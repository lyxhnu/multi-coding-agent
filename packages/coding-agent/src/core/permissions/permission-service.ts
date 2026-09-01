import { NULL_AUDIT_LOG, type PermissionAuditLog } from "./audit-log.ts";
import { decideToolPermission } from "./policy.ts";
import type { PermissionCheckResult, PermissionMode, PermissionRule } from "./types.ts";

export interface PermissionServiceOptions {
	getMode: () => PermissionMode;
	getAllowRules?: () => PermissionRule[] | undefined;
	getDenyRules?: () => PermissionRule[] | undefined;
	auditLog?: PermissionAuditLog;
	/** Whether to persist decisions to `auditLog`. Checked on every call; defaults to true. */
	getAuditEnabled?: () => boolean;
	sessionId?: string;
	getCwd?: () => string | undefined;
}

/**
 * Core permission decision service. This is the "final guard" referenced by
 * `Agent.guardToolCall`: it is wired once per session (see agent-session.ts)
 * and always runs after any extension has had a chance to mutate tool
 * arguments and after those arguments have been re-validated against the
 * tool's schema. Extensions can provide UI around this (approval dialogs,
 * settings screens) but cannot make this service allow something it would
 * otherwise ask about or deny — it does not expose a bypass hook.
 *
 * When the decision is "ask" and the caller has no way to resolve that (no
 * interactive approval channel wired up yet), the caller must fail closed —
 * this service intentionally does not guess.
 */
export class PermissionService {
	private readonly options: PermissionServiceOptions;

	constructor(options: PermissionServiceOptions) {
		this.options = options;
	}

	evaluate(toolName: string, args: unknown, toolCallId?: string): PermissionCheckResult {
		const mode = this.options.getMode();
		const result = decideToolPermission({
			toolName,
			args,
			mode,
			allow: this.options.getAllowRules?.(),
			deny: this.options.getDenyRules?.(),
			cwd: this.options.getCwd?.(),
		});

		if (this.options.getAuditEnabled?.() ?? true) {
			(this.options.auditLog ?? NULL_AUDIT_LOG).record({
				sessionId: this.options.sessionId,
				toolCallId,
				toolName,
				operation: result.operation,
				mode,
				decision: result.decision,
				source: result.source,
				reason: result.reason,
			});
		}

		return result;
	}
}
