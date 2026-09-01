/**
 * Bash command risk analysis.
 *
 * This is a static, best-effort classifier used by the permission policy
 * (see policy.ts) to decide whether a `bash` tool call can be auto-allowed,
 * must be asked about, or is outright dangerous. It intentionally does not
 * attempt a full shell grammar: shells have too many corners (process
 * substitution, arrays, brace expansion, aliases, functions...) to parse
 * perfectly. Instead it aims to be conservative: anything it cannot prove
 * safe is classified as at least "ask", never silently "safe".
 *
 * This is NOT a sandbox. It only informs the allow/ask/deny decision in
 * policy.ts; it cannot stop a command from doing whatever it does once
 * executed.
 */

export type BashRisk = "safe" | "ask" | "dangerous";

export interface BashCommandAnalysis {
	risk: BashRisk;
	/** Human-readable reasons contributing to `risk`, most severe first. */
	reasons: string[];
	/** True when the command could not be confidently tokenized (unbalanced quotes/heredoc/etc). */
	parseError: boolean;
	/** Top-level segments as split on &&, ||, ;, |, & (for callers that want detail). */
	segments: string[];
}

interface Segment {
	command: string;
	operator: string | null;
}

const RISK_ORDER: Record<BashRisk, number> = { safe: 0, ask: 1, dangerous: 2 };

function maxRisk(a: BashRisk, b: BashRisk): BashRisk {
	return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

// ---------------------------------------------------------------------------
// Heredoc stripping
// ---------------------------------------------------------------------------

const HEREDOC_START = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/**
 * Replace heredoc bodies with a placeholder so their contents (which may
 * contain `;`, `|`, `&&`, quotes, etc.) are never mistaken for top-level
 * shell operators. Returns the rewritten command, whether any heredoc was
 * found, and whether a heredoc's closing delimiter could not be located
 * (parse failure).
 */
function stripHeredocBodies(command: string): { text: string; hasHeredoc: boolean; parseError: boolean } {
	let text = command;
	let hasHeredoc = false;
	let searchFrom = 0;

	// Bounded loop: at most one pass per heredoc marker found, and each pass
	// strictly shrinks the remaining unscanned suffix.
	while (searchFrom < text.length) {
		const remainder = text.slice(searchFrom);
		const match = HEREDOC_START.exec(remainder);
		if (!match) break;

		hasHeredoc = true;
		const stripsIndent = match[0].startsWith("<<-");
		const delimiter = match[2];
		const matchStart = searchFrom + match.index;
		const bodyStart = matchStart + match[0].length;

		const lines = text.slice(bodyStart).split("\n");
		let consumed = 0;
		let closingLineIndex = -1;
		for (let i = 1; i < lines.length; i++) {
			const line = lines[i];
			const candidate = stripsIndent ? line.replace(/^\t+/, "") : line;
			if (candidate === delimiter) {
				closingLineIndex = i;
				break;
			}
		}

		if (closingLineIndex === -1) {
			// No closing delimiter found anywhere in the rest of the command.
			return { text, hasHeredoc, parseError: true };
		}

		consumed = lines.slice(0, closingLineIndex + 1).join("\n").length;
		const bodyEnd = bodyStart + consumed;
		text = `${text.slice(0, matchStart)} <<HEREDOC>> ${text.slice(bodyEnd)}`;
		searchFrom = matchStart + " <<HEREDOC>> ".length;
	}

	return { text, hasHeredoc, parseError: false };
}

// ---------------------------------------------------------------------------
// Top-level segment splitting (quote/paren/backtick aware)
// ---------------------------------------------------------------------------

/**
 * True when an `&` is part of a redirection rather than a top-level background operator.
 *
 * Two shapes matter, and both are extremely common in agent-issued commands:
 *   - fd duplication:      `2>&1`, `>&2`, `1>& 2`  — the `&` follows a `>`
 *   - redirect-both:       `&> out`, `&>> out`      — the `&` precedes a `>`
 *
 * Treating either as a background operator splits the command mid-redirection and leaves the fd number
 * standing alone as its own "segment", so `ls -la 2>&1` gets classified as running a command named `1`.
 * That misread accounted for the single largest share of spurious approval prompts observed in
 * benchmark runs, including on commands as ordinary as `echo hi 2>&1`.
 */
function isRedirectionAmpersand(before: string, next: string | undefined): boolean {
	if (next === ">") return true; // `&>` / `&>>`
	const prev = before.trimEnd();
	return prev.endsWith(">"); // `>&` / `2>&` / `>>&`
}

/**
 * Split a command into top-level segments on &&, ||, ;, |, & while respecting
 * single/double quotes, backslash escapes, $(...) / `...` command
 * substitution, and {..}/(..) grouping. Returns `undefined` if quoting or
 * nesting never balances (parse failure).
 */
function splitTopLevelSegments(command: string): Segment[] | undefined {
	const segments: Segment[] = [];
	let depth = 0; // depth of $(), (), {}, backticks (treated as a single nesting kind)
	let inSingle = false;
	let inDouble = false;
	let backtickDepth = 0;
	let current = "";
	let pendingOperator: string | null = null;

	const pushSegment = (operator: string | null) => {
		const trimmed = current.trim();
		if (trimmed.length > 0) {
			segments.push({ command: trimmed, operator: pendingOperator });
		}
		current = "";
		pendingOperator = operator;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		const next = command[i + 1];

		if (inSingle) {
			current += ch;
			if (ch === "'") inSingle = false;
			continue;
		}
		if (ch === "\\" && !inSingle) {
			// Backslash escapes the following character (outside single quotes).
			current += ch + (next ?? "");
			i++;
			continue;
		}
		if (inDouble) {
			current += ch;
			if (ch === '"') inDouble = false;
			continue;
		}
		if (ch === "`") {
			current += ch;
			backtickDepth = backtickDepth === 0 ? 1 : 0;
			continue;
		}
		if (backtickDepth > 0) {
			current += ch;
			continue;
		}
		if (ch === "'") {
			inSingle = true;
			current += ch;
			continue;
		}
		if (ch === '"') {
			inDouble = true;
			current += ch;
			continue;
		}
		if (ch === "(" || ch === "{") {
			depth++;
			current += ch;
			continue;
		}
		if (ch === ")" || ch === "}") {
			depth = Math.max(0, depth - 1);
			current += ch;
			continue;
		}
		if (depth > 0) {
			current += ch;
			continue;
		}

		// Top-level operator detection.
		if (ch === "&" && next === "&") {
			pushSegment("&&");
			i++;
			continue;
		}
		if (ch === "|" && next === "|") {
			pushSegment("||");
			i++;
			continue;
		}
		if (ch === "|" && next === "&") {
			// bash's `|&` (pipe stdout+stderr). One operator, not `|` followed by a
			// background `&` — the latter reading would leave the `&` starting a new
			// segment with no command in front of it.
			pushSegment("|&");
			i++;
			continue;
		}
		if (ch === "|") {
			pushSegment("|");
			continue;
		}
		if (ch === ";") {
			pushSegment(";");
			continue;
		}
		if (ch === "&" && !isRedirectionAmpersand(current, next)) {
			pushSegment("&");
			continue;
		}

		current += ch;
	}

	if (inSingle || inDouble || depth !== 0 || backtickDepth !== 0) {
		return undefined;
	}
	pushSegment(null);
	return segments;
}

// ---------------------------------------------------------------------------
// Per-segment classification
// ---------------------------------------------------------------------------

const WRAPPER_WORDS = new Set(["sudo", "doas", "env", "command", "builtin", "nohup", "exec", "time", "nice", "ionice"]);

const SHELL_EVAL_RE = /^(sh|bash|zsh|dash|ksh)\s+(-[a-zA-Z]*c\b|.*-c\b)/;

/**
 * Commands that do not warrant interrupting the user for approval.
 *
 * This is a "not worth asking about" list, not a proof of harmlessness: `node script.js` was already on
 * it, and no static check can bound what that script does. Excluding `python`/`make`/`gcc` while
 * admitting `node`/`npm` was therefore not a security boundary, just an inconsistency — and a costly one
 * for a coding agent, since it made ordinary build/test/run loops unavailable. Anything that mutates
 * system state, needs root, or fetches-and-executes stays off the list on purpose (see the notes below),
 * and the dangerous-pattern rules plus the redirection-target check still apply to every command here.
 */
const SAFE_ARGV0 = new Set([
	// Inspection / read-only
	"ls",
	"cat",
	"pwd",
	"echo",
	"printf",
	"head",
	"tail",
	"wc",
	"grep",
	"egrep",
	"fgrep",
	"rg",
	"ag",
	"find",
	"fd",
	"which",
	"whereis",
	"type",
	"whoami",
	"id",
	"groups",
	"date",
	"env",
	"printenv",
	"uname",
	"hostname",
	"uptime",
	"ps",
	"true",
	"false",
	"test",
	"[",
	"diff",
	"cmp",
	"sort",
	"uniq",
	"cut",
	"paste",
	"join",
	"tr",
	"nl",
	"tac",
	"rev",
	"seq",
	"basename",
	"dirname",
	"realpath",
	"readlink",
	"stat",
	"file",
	"du",
	"df",
	"tree",
	"od",
	"xxd",
	"hexdump",
	"strings",
	"base64",
	"md5sum",
	"sha1sum",
	"sha256sum",
	"cksum",
	"sleep",
	"xargs",
	"tee",
	"sed",
	"awk",
	"jq",
	"yq",

	// Navigation. `cd` is a builtin that cannot outlive its own segment, yet omitting it meant the
	// overwhelmingly common `cd sub && <build>` shape needed approval for the `cd` alone.
	"cd",
	"pushd",
	"popd",

	// Workspace file manipulation. Scoped by the paths the caller passes; destructive *patterns*
	// (`rm -rf`, `chmod 777`, writes to unverifiable paths) are still caught separately. Bare `rm` is
	// deliberately absent: deleting a file is worth one confirmation in an interactive session.
	"mkdir",
	"rmdir",
	"touch",
	"cp",
	"mv",
	"ln",
	"chmod",

	// Archives
	"tar",
	"unzip",
	"zip",
	"gzip",
	"gunzip",
	"zcat",
	"bzip2",
	"xz",

	// Language runtimes, package managers scoped to the project, build + test drivers.
	// Equivalent in power to the already-listed `node`/`npm`, and a coding agent cannot work without them.
	"node",
	"npm",
	"npx",
	"pnpm",
	"yarn",
	"bun",
	"deno",
	"tsc",
	"tsx",
	"python",
	"python2",
	"python3",
	"pip",
	"pip3",
	"pipx",
	"uv",
	"poetry",
	"pdm",
	"pytest",
	"py.test",
	"tox",
	"ruff",
	"black",
	"isort",
	"mypy",
	"flake8",
	"pylint",
	"make",
	"cmake",
	"ninja",
	"meson",
	"gcc",
	"g++",
	"cc",
	"c++",
	"clang",
	"clang++",
	"ld",
	"ar",
	"nm",
	"objdump",
	"readelf",
	"strip",
	"pkg-config",
	"cargo",
	"rustc",
	"rustup",
	"go",
	"gofmt",
	"java",
	"javac",
	"mvn",
	"gradle",
	"ruby",
	"gem",
	"bundle",
	"perl",
	"php",
	"composer",
	"dotnet",
	"swift",
	"lua",
	"Rscript",

	// VCS. Push/force-push style destruction is handled by the dangerous-pattern rules.
	"git",
]);

/**
 * Deliberately NOT on the safe list, with the reason, so the next person does not "fix" it by adding them:
 *   - `rm`                      — irreversible; one confirmation per interactive session is cheap
 *   - `sudo` / `su` / `doas`    — privilege escalation (also stripped as wrappers, then re-checked)
 *   - `apt-get`/`apt`/`dpkg`/`yum`/`dnf`/`apk`/`brew` — mutate system state as root, run maintainer scripts
 *   - `curl` / `wget`           — entry point of the fetch-then-execute chain
 *   - `ssh` / `scp` / `rsync`   — reach other hosts
 *   - `kill` / `killall` / `pkill` / `reboot` / `shutdown` / `mount` / `systemctl` — host/process control
 *   - `sh` / `bash` / `zsh` -c  — opaque nested command (handled by SHELL_EVAL_RE)
 * Non-interactive callers that genuinely want all of this should set permissions.mode, not widen the list.
 */

/** Trailing version suffix on an interpreter/toolchain binary: `python3.13`, `gcc-13`, `clang++-18`, `pip3.11`. */
const VERSIONED_BINARY_RE = /^([A-Za-z][A-Za-z+_-]*?)-?(\d+(?:\.\d+)*)$/;

/**
 * GNU cross-toolchain prefix: `mipsel-linux-gnu-gcc`, `arm-none-eabi-ld`, `x86_64-w64-mingw32-g++`.
 * The trailing tool is the same program as its host-native counterpart.
 */
const CROSS_TOOLCHAIN_RE = /^[A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)+-([a-z+]+(?:\+\+)?)$/;

/**
 * Safe-list membership, tolerating the versioned and cross-prefixed binary names that real toolchains
 * install. `python3.13`, `gcc-13`, `pip3.11`, and `mipsel-linux-gnu-gcc` are the same programs as
 * `python3`, `gcc`, `pip3`, and `gcc`; treating them as unknown commands only teaches an agent to keep
 * guessing which spelling is allowed.
 */
function isSafeArgv0(bare: string): boolean {
	if (SAFE_ARGV0.has(bare)) return true;

	const versioned = VERSIONED_BINARY_RE.exec(bare);
	if (versioned) {
		const stem = versioned[1];
		// `python3.13` -> try `python3` (stem + leading major) then `python`.
		const major = versioned[2].split(".")[0];
		if (SAFE_ARGV0.has(`${stem}${major}`) || SAFE_ARGV0.has(stem)) return true;
	}

	const cross = CROSS_TOOLCHAIN_RE.exec(bare);
	if (cross && SAFE_ARGV0.has(cross[1])) return true;

	return false;
}

/**
 * Regexes matched against the *whole* segment text (post-wrapper-strip).
 * These describe single-segment dangerous patterns only — patterns that
 * inherently span a top-level operator (like `curl ... | sh` spanning `|`,
 * or a fork bomb spanning `;`) must go in `WHOLE_COMMAND_DANGEROUS_PATTERNS`
 * below instead, since `splitTopLevelSegments` removes those operators from
 * the segment text before `classifySegment` ever sees it.
 */
const DANGEROUS_SEGMENT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
	{ re: /\brm\b[^|;&]*\s-[a-zA-Z]*[rf][a-zA-Z]*[rf]?\b/, reason: "recursive/force file removal (rm -rf style)" },
	{ re: /\bchmod\b[^|;&]*\b777\b/, reason: "chmod 777 (world-writable permissions)" },
	{ re: /\bchown\b[^|;&]*\s-[a-zA-Z]*R\b/, reason: "recursive chown" },
	{ re: /\bgit\s+push\b[^|;&]*(--force\b|-f\b)/, reason: "force push (can overwrite remote history)" },
	{ re: /\bgit\s+reset\b[^|;&]*--hard\b/, reason: "git reset --hard (discards local changes)" },
	{ re: /\bgit\s+clean\b[^|;&]*-[a-zA-Z]*f/, reason: "git clean -f (deletes untracked files)" },
	{ re: /\bmkfs\b/, reason: "filesystem format command" },
	{ re: /\bdd\b[^|;&]*\bof=\/dev\//, reason: "raw disk write via dd" },
	{ re: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "system power state change" },
	{ re: /\bkill\b[^|;&]*(-9\b|-KILL\b)[^|;&]*\b1\b/, reason: "kill signal targeting PID 1" },
];

/** Patterns that inherently span a top-level operator; checked against the un-split command text. */
const FORK_BOMB_RE = /:\(\)\s*\{\s*:\s*\|\s*:\s*&?\s*\}\s*;?\s*:/;

/** Patterns indicating a downloader piped straight into a shell interpreter. */
const DOWNLOAD_EXECUTE_RE =
	/\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(sh|bash|zsh|dash|ksh)\b|\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(node|python3?|ruby|perl)\b/;

const WHOLE_COMMAND_DANGEROUS_PATTERNS: Array<{ re: RegExp; reason: string }> = [
	{ re: FORK_BOMB_RE, reason: "fork bomb pattern" },
	{ re: DOWNLOAD_EXECUTE_RE, reason: "downloads content and pipes it directly into a shell/interpreter" },
];

const SENSITIVE_PATH_RE =
	/(^|[\s"'])(~\/\.ssh|~\/\.aws|~\/\.gnupg|~\/\.docker\/config\.json|\/etc\/passwd|\/etc\/shadow|\/etc\/sudoers|\.\.\/){1}/;

function hasCommandSubstitution(segment: string): boolean {
	// `$(` or a backtick appearing outside single quotes indicates dynamic,
	// statically-unverifiable command construction.
	let inSingle = false;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "\\") {
			i++;
			continue;
		}
		if (ch === "'" && !inSingle) {
			inSingle = true;
			continue;
		}
		if (ch === "'" && inSingle) {
			inSingle = false;
			continue;
		}
		if (inSingle) continue;
		if (ch === "`") return true;
		if (ch === "$" && segment[i + 1] === "(") return true;
	}
	return false;
}

/** Redirection targets treated as no-ops (discarding output), never a real file write. */
const BENIGN_REDIRECTION_TARGETS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "&1", "&2"]);

/**
 * Detects `>`, `>>`, `2>`, `&>`, `1>` output redirection outside quotes/substitution (spec 3.4:
 * "redirection：`>`、`>>`、`2>`、`&>`") and returns the (best-effort) target path tokens, so callers can
 * tell a real file write (`> ~/.bashrc`) from a harmless discard (`> /dev/null 2>&1`). Pure fd
 * duplication (`2>&1`) names no file and yields no target.
 */
function findOutputRedirectionTargets(segment: string): string[] {
	const targets: string[] = [];
	let inSingle = false;
	let inDouble = false;
	for (let i = 0; i < segment.length; i++) {
		const ch = segment[i];
		if (ch === "\\" && !inSingle) {
			i++;
			continue;
		}
		if (ch === "'" && !inDouble) {
			inSingle = !inSingle;
			continue;
		}
		if (ch === '"' && !inSingle) {
			inDouble = !inDouble;
			continue;
		}
		if (inSingle || inDouble) continue;
		if (ch !== ">") continue;
		let j = i + 1;
		if (segment[j] === ">") j++; // `>>`
		if (segment[j] === "&") {
			// fd duplication (`2>&1`, `>&2`): redirects one descriptor onto another, it never
			// names a file, so there is no write target to vet. Reading the fd number as a
			// path would flag `... 2>&1` as "writes to a file called 1".
			continue;
		}
		while (segment[j] === " ") j++;
		const rest = segment.slice(j);
		const targetMatch = /^([^\s|;&]+)/.exec(rest);
		if (targetMatch) targets.push(targetMatch[1]);
	}
	return targets;
}

/**
 * The argv0 token of a segment.
 *
 * `+` and `[` are part of the character class on purpose. Leaving `+` out truncated `g++` to `g` and
 * `c++` to `c`, so those safe-list entries never matched — and, more importantly, a name like `git+x`
 * would have been truncated to `git` and matched the safe list, letting an arbitrary binary through on a
 * prefix collision. Matching the whole token and then looking it up is both correct and stricter.
 */
function extractLeadingWord(segment: string): string | undefined {
	const match = /^([A-Za-z0-9_./+[-]+)/.exec(segment.trim());
	return match?.[1];
}

/**
 * Drop leading `VAR=value` assignments so the real command is what gets classified.
 *
 * `DEBIAN_FRONTEND=noninteractive apt-get ...` and `PATH=/opt/bin:$PATH make ...` are ordinary shell
 * shapes, but without this the assignment itself is read as argv0 and reported as a command named
 * `DEBIAN_FRONTEND` or `PATH` — which is both a confusing denial reason and, worse, hides the real
 * command (`apt-get`) from the classifier that is supposed to be vetting it.
 */
function stripLeadingAssignments(segment: string): string {
	let rest = segment.trim();
	// Bounded: each iteration consumes one assignment token.
	for (let guard = 0; guard < 16; guard++) {
		const match = /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/.exec(rest);
		if (!match) break;
		rest = rest.slice(match[0].length).trimStart();
	}
	return rest;
}

/** Strip a leading chain of wrapper commands (sudo, env, nohup, ...). Returns the inner command text. */
function stripWrappers(segment: string): { inner: string; wrappers: string[] } {
	let inner = stripLeadingAssignments(segment.trim());
	const wrappers: string[] = [];
	// Bounded: each iteration must consume a leading word, so this cannot loop forever.
	for (let guard = 0; guard < 8; guard++) {
		const word = extractLeadingWord(inner);
		if (!word) break;
		const bare = word.split("/").pop() ?? word;
		if (!WRAPPER_WORDS.has(bare)) break;
		wrappers.push(bare);
		inner = inner.slice(word.length).trim();
		// Skip simple flags for wrappers like `nice -n 10 <cmd>` or `env FOO=bar <cmd>`.
		while (/^(-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=\S*)/.test(inner)) {
			const flagMatch = /^\S+/.exec(inner);
			if (!flagMatch) break;
			inner = inner.slice(flagMatch[0].length).trim();
		}
		inner = stripLeadingAssignments(inner);
	}
	return { inner, wrappers };
}

function classifySegment(rawSegment: string): { risk: BashRisk; reasons: string[] } {
	const reasons: string[] = [];
	let risk: BashRisk = "safe";

	if (DOWNLOAD_EXECUTE_RE.test(rawSegment)) {
		return { risk: "dangerous", reasons: ["downloads content and pipes it directly into a shell/interpreter"] };
	}
	for (const { re, reason } of DANGEROUS_SEGMENT_PATTERNS) {
		if (re.test(rawSegment)) {
			risk = "dangerous";
			reasons.push(reason);
		}
	}
	if (risk === "dangerous") {
		return { risk, reasons };
	}

	if (SENSITIVE_PATH_RE.test(rawSegment)) {
		risk = maxRisk(risk, "ask");
		reasons.push(
			"references a sensitive path (ssh/aws/gnupg credentials, /etc auth files, or parent-directory traversal)",
		);
	}

	if (hasCommandSubstitution(rawSegment)) {
		risk = maxRisk(risk, "ask");
		reasons.push("uses command substitution ($(...) or backticks), which cannot be statically verified");
	}

	const redirectionTargets = findOutputRedirectionTargets(rawSegment).filter(
		(t) => !BENIGN_REDIRECTION_TARGETS.has(t),
	);
	if (redirectionTargets.length > 0) {
		risk = maxRisk(risk, "ask");
		reasons.push(`redirects output to ${redirectionTargets.join(", ")}, which cannot be verified as safe`);
	}

	const { inner, wrappers } = stripWrappers(rawSegment);
	if (wrappers.includes("sudo") || wrappers.includes("doas")) {
		risk = maxRisk(risk, "ask");
		reasons.push("runs as another user via sudo/doas");
	}

	if (SHELL_EVAL_RE.test(inner)) {
		risk = maxRisk(risk, "ask");
		reasons.push("evaluates an opaque shell string via `-c` (inner command not analyzed)");
		return { risk, reasons };
	}

	const argv0 = extractLeadingWord(inner);
	if (!argv0) {
		risk = maxRisk(risk, "ask");
		reasons.push("could not determine the command to run");
		return { risk, reasons };
	}

	const bareArgv0 = argv0.split("/").pop() ?? argv0;
	if (!isSafeArgv0(bareArgv0)) {
		risk = maxRisk(risk, "ask");
		reasons.push(`command "${bareArgv0}" is not on the built-in safe list`);
	}

	return { risk, reasons };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function analyzeBashCommand(command: string): BashCommandAnalysis {
	if (command.includes("\0")) {
		return { risk: "dangerous", reasons: ["command contains a NUL byte"], parseError: true, segments: [] };
	}

	const { text: withoutHeredocs, hasHeredoc, parseError: heredocParseError } = stripHeredocBodies(command);
	if (heredocParseError) {
		return {
			risk: "ask",
			reasons: ["heredoc (<<) has no matching closing delimiter; cannot verify command contents"],
			parseError: true,
			segments: [],
		};
	}

	const segments = splitTopLevelSegments(withoutHeredocs);
	if (!segments) {
		return {
			risk: "ask",
			reasons: ["command has unbalanced quotes or grouping; cannot verify contents"],
			parseError: true,
			segments: [],
		};
	}

	let risk: BashRisk = "safe";
	const reasons: string[] = [];

	// Checked against the un-split command text: some dangerous patterns
	// (a fork bomb's `;`, a `curl ... | sh` pipeline) inherently span the very
	// operators `splitTopLevelSegments` splits on, so they must be found here
	// rather than in any single segment (see WHOLE_COMMAND_DANGEROUS_PATTERNS).
	for (const { re, reason } of WHOLE_COMMAND_DANGEROUS_PATTERNS) {
		if (re.test(withoutHeredocs)) {
			risk = "dangerous";
			if (!reasons.includes(reason)) reasons.push(reason);
		}
	}

	for (const segment of segments) {
		const classified = classifySegment(segment.command);
		risk = maxRisk(risk, classified.risk);
		for (const reason of classified.reasons) {
			if (!reasons.includes(reason)) reasons.push(reason);
		}
	}

	if (hasHeredoc) {
		risk = maxRisk(risk, "ask");
		const heredocReason = "writes a heredoc (<<) body whose contents are not analyzed";
		if (!reasons.includes(heredocReason)) reasons.push(heredocReason);
	}

	if (segments.length === 0) {
		return { risk: "safe", reasons: [], parseError: false, segments: [] };
	}

	return { risk, reasons, parseError: false, segments: segments.map((s) => s.command) };
}
