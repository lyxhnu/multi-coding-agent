import { appendFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { PermissionDecision, PermissionDecisionSource, PermissionMode } from "./types.ts";

/**
 * Secret-like patterns redacted before anything is persisted to the audit
 * log or shown in a "redacted operation" summary. Deliberately broad and
 * pattern-based (not a secret scanner): false positives (over-redaction) are
 * safe, false negatives are not.
 */
const SECRET_PATTERNS: RegExp[] = [
	// KEY=value / KEY: value style assignments for token/secret/password/key-ish names.
	// The identifier prefix before the keyword is optional (`*`, not `+`) so bare names
	// like "API_KEY=..." match, not just longer ones like "MY_API_KEY=...".
	/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*(['"]?)\S+\1/gi,
	// Authorization / Bearer headers.
	/\b(Authorization|Bearer)\s*[:=]\s*\S+/gi,
	// URL userinfo (https://user:pass@host).
	/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/gi,
	// PEM-style private key blocks.
	/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	// Long high-entropy-looking tokens passed as bare CLI args after --token/--password/--api-key.
	/--?(token|password|api-key|apikey|secret)[=\s]+\S+/gi,
];

const REDACTED = "[REDACTED]";

/** Redact secret-shaped substrings from a command/operation string before logging or displaying it. */
export function redactForAudit(text: string): string {
	let result = text;
	for (const pattern of SECRET_PATTERNS) {
		result = result.replace(pattern, REDACTED);
	}
	return result;
}

export interface PermissionAuditEntry {
	timestamp: string;
	sessionId?: string;
	toolCallId?: string;
	toolName: string;
	/** Redacted, human-readable operation summary — never the raw, unredacted command. */
	operation: string;
	mode: PermissionMode;
	decision: PermissionDecision;
	source: PermissionDecisionSource;
	reason: string;
}

export interface PermissionAuditLog {
	record(entry: Omit<PermissionAuditEntry, "timestamp">): void;
}

/** No-op logger, used when auditing is disabled. */
export const NULL_AUDIT_LOG: PermissionAuditLog = {
	record() {},
};

/** Appends one JSON object per line to `filePath`. Creates parent directories on first write. Best-effort: logging failures never throw. */
export class JsonlPermissionAuditLog implements PermissionAuditLog {
	private initialized = false;
	private readonly filePath: string;

	constructor(filePath: string) {
		this.filePath = filePath;
	}

	record(entry: Omit<PermissionAuditEntry, "timestamp">): void {
		try {
			this.ensureFile();
			const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`;
			appendFileSync(this.filePath, line, { encoding: "utf-8", mode: 0o600 });
		} catch {
			// Audit logging must never break tool execution.
		}
	}

	private ensureFile(): void {
		if (this.initialized) return;
		const dir = dirname(this.filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
		if (existsSync(this.filePath)) {
			try {
				chmodSync(this.filePath, 0o600);
			} catch {
				// Best-effort permission tightening; ignore on platforms/filesystems that don't support it.
			}
		}
		this.initialized = true;
	}
}
