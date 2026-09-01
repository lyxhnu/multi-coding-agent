/**
 * Secret filter for the Grok-aligned memory system (spec 10.6): unlike the permission audit log
 * (audit-log.ts), which redacts secret-shaped substrings in place so a log line stays useful, memory
 * candidates that look like they contain a secret are discarded *in full* — partial memories are more
 * dangerous than none, since they'd be replayed as trusted long-term context later.
 */

const SECRET_LIKE_PATTERNS: RegExp[] = [
	// KEY=value / KEY: value style assignments for token/secret/password/key-ish names.
	/\b[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIAL)[A-Za-z0-9_]*\s*[=:]\s*(['"]?)\S+\1/i,
	// Authorization / Bearer / Cookie headers.
	/\b(Authorization|Bearer|Cookie)\s*[:=]\s*\S+/i,
	// URL userinfo (https://user:pass@host).
	/(https?:\/\/)([^\s/@]+):([^\s/@]+)@/i,
	// PEM-style private key blocks.
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	// Long high-entropy-looking tokens passed as bare CLI args after --token/--password/--api-key.
	/--?(token|password|api-key|apikey|secret)[=\s]+\S+/i,
	// .env-style bare assignment of an all-caps identifier to a long opaque value.
	/^[A-Z][A-Z0-9_]{2,}=\S{12,}$/m,
];

/** Shannon entropy in bits/char. Random base64/hex secrets score much higher than prose or code identifiers. */
function shannonEntropy(text: string): number {
	if (text.length === 0) return 0;
	const counts = new Map<string, number>();
	for (const ch of text) counts.set(ch, (counts.get(ch) ?? 0) + 1);
	let entropy = 0;
	for (const count of counts.values()) {
		const p = count / text.length;
		entropy -= p * Math.log2(p);
	}
	return entropy;
}

/** Longest opaque-looking token (letters/digits/+/-/_/=, no whitespace, length >= 24). */
const OPAQUE_TOKEN_RE = /[A-Za-z0-9+/_=-]{24,}/g;
const HIGH_ENTROPY_BITS_PER_CHAR = 3.5;

function findHighEntropyToken(text: string): string | undefined {
	for (const match of text.matchAll(OPAQUE_TOKEN_RE)) {
		if (shannonEntropy(match[0]) >= HIGH_ENTROPY_BITS_PER_CHAR) return match[0];
	}
	return undefined;
}

export interface SecretFilterResult {
	safe: boolean;
	reason?: string;
}

/** Checks one memory candidate (a note/fact about to be written). Discards the whole thing on any hit. */
export function checkMemoryCandidate(text: string): SecretFilterResult {
	for (const pattern of SECRET_LIKE_PATTERNS) {
		if (pattern.test(text)) {
			return { safe: false, reason: "secret_pattern" };
		}
	}
	const entropyHit = findHighEntropyToken(text);
	if (entropyHit) {
		return { safe: false, reason: "high_entropy_token" };
	}
	return { safe: true };
}

/** Filters a batch of candidates, returning only the ones that passed, plus a count of how many were skipped. */
export function filterMemoryCandidates(candidates: string[]): { kept: string[]; skipped: number } {
	const kept: string[] = [];
	let skipped = 0;
	for (const candidate of candidates) {
		if (checkMemoryCandidate(candidate).safe) kept.push(candidate);
		else skipped++;
	}
	return { kept, skipped };
}
