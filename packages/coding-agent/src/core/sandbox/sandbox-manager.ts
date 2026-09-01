/**
 * Grok-aligned SandboxManager (spec 12): builds the OS-level wrapper command for a given sandbox
 * profile. macOS uses sandbox-exec; Linux uses bwrap; anything else (including Windows, where a real
 * backend would be a job object / restricted token) has no backend yet and fails closed for
 * read-only/strict profiles or when mode="required" — it never silently runs those unsandboxed.
 */

import { existsSync, realpathSync } from "node:fs";
import type { ChildNetworkPolicy, ResolvedSandboxSettings, SandboxProfileName } from "./types.ts";
import { profileName } from "./types.ts";

export interface SandboxCommand {
	command: string;
	args: string[];
}

export type SandboxBuildResult =
	| { ok: true; wrapped: SandboxCommand; profile: SandboxProfileName | "custom"; auditRequired: boolean }
	| { ok: false; reason: string; profile: SandboxProfileName | "custom" };

const SANDBOXED_PLATFORMS = new Set<NodeJS.Platform>(["darwin", "linux"]);

/** Profiles that must never run unsandboxed, even in best-effort mode, when no backend exists (spec 12: "未实现时 strict fail-closed"). */
const ALWAYS_FAIL_CLOSED_WHEN_UNIMPLEMENTED = new Set<SandboxProfileName>(["read-only", "strict"]);

function buildMacOsProfileText(
	profile: SandboxProfileName,
	workspaceRoot: string,
	childNetwork: ChildNetworkPolicy,
): string {
	const lines: string[] = [
		"(version 1)",
		"(deny default)",
		"(allow process-fork)",
		"(allow process-exec*)",
		"(allow signal)",
		"(allow sysctl-read)",
		"(allow mach-lookup)",
		"(allow ipc-posix-shm)",
	];

	if (profile === "strict") {
		lines.push(`(allow file-read* (subpath "${workspaceRoot}"))`);
		lines.push(
			'(allow file-read* (subpath "/usr/lib") (subpath "/usr/share") (subpath "/System") (subpath "/Library"))',
		);
	} else {
		lines.push("(allow file-read*)");
	}

	if (profile === "workspace" || profile === "devbox") {
		lines.push(`(allow file-write* (subpath "${workspaceRoot}"))`);
		lines.push('(allow file-write* (subpath "/tmp") (subpath "/private/tmp") (subpath "/private/var/folders"))');
		if (profile === "devbox") {
			const home = process.env.HOME ?? "";
			if (home) {
				lines.push(`(allow file-write* (subpath "${home}/.npm"))`);
				lines.push(`(allow file-write* (subpath "${home}/.cache"))`);
			}
		}
	}
	// read-only and strict: no file-write* allow at all — falls through to the leading (deny default).

	if (childNetwork === "unrestricted") {
		lines.push("(allow network*)");
	} else if (childNetwork === "websites") {
		// sandbox-exec cannot filter by domain; documented limitation (see spec 3.4 "WARNING: Domain-level filtering not implemented").
		lines.push("(allow network*)");
	}
	// "blocked": no network allow rule — falls through to (deny default).

	return lines.join("\n");
}

function buildBwrapArgs(
	profile: SandboxProfileName,
	workspaceRoot: string,
	childNetwork: ChildNetworkPolicy,
): string[] {
	const args = [
		"--ro-bind",
		"/usr",
		"/usr",
		"--ro-bind",
		"/lib",
		"/lib",
		"--ro-bind",
		"/bin",
		"/bin",
		"--ro-bind",
		"/etc/resolv.conf",
		"/etc/resolv.conf",
		"--proc",
		"/proc",
		"--dev",
		"/dev",
		"--chdir",
		workspaceRoot,
	];
	if (profile === "workspace" || profile === "devbox") {
		args.push("--bind", workspaceRoot, workspaceRoot, "--bind", "/tmp", "/tmp");
	} else {
		// read-only / strict: bind the workspace read-only, never writable.
		args.push("--ro-bind", workspaceRoot, workspaceRoot);
	}
	if (childNetwork === "blocked") {
		args.push("--unshare-net");
	} else {
		args.push("--share-net");
	}
	return args;
}

export interface SandboxManagerOptions {
	workspaceRoot: string;
	/** Overridable for tests; defaults to the real process.platform. */
	platform?: NodeJS.Platform;
}

export class SandboxManager {
	private readonly workspaceRoot: string;
	private readonly platform: NodeJS.Platform;

	constructor(options: SandboxManagerOptions) {
		// Canonicalize through symlinks up front (e.g. macOS /tmp -> /private/tmp, /var -> /private/var):
		// sandbox-exec's `subpath` rules and bwrap's binds are checked against the kernel's *resolved*
		// path, so an allow-rule built from the unresolved path would silently fail to match and deny
		// legitimate in-workspace writes (the same class of bug fixed in path-inspector.ts's isWithinScope).
		let resolvedRoot = options.workspaceRoot;
		try {
			if (existsSync(options.workspaceRoot)) resolvedRoot = realpathSync(options.workspaceRoot);
		} catch {
			// Best-effort: fall back to the unresolved path if realpath fails (permissions, race).
		}
		this.workspaceRoot = resolvedRoot;
		this.platform = options.platform ?? process.platform;
	}

	/** Builds the wrapped {command, args} that actually runs `command` under the configured sandbox profile. */
	build(command: string, args: string[], settings: ResolvedSandboxSettings): SandboxBuildResult {
		const name = profileName(settings.profile);

		if (name === "off") {
			// Grok rule (spec 12): "off 必须审计" — never silent.
			return { ok: true, wrapped: { command, args }, profile: "off", auditRequired: true };
		}

		if (name === "custom") {
			// A custom profile is caller-provided sandbox-exec/bwrap text; we can't validate it here, only pass it through.
			if (this.platform === "darwin") {
				const customProfile = (settings.profile as { custom: string }).custom;
				return {
					ok: true,
					wrapped: { command: "sandbox-exec", args: ["-p", customProfile, "--", command, ...args] },
					profile: "custom",
					auditRequired: false,
				};
			}
			return this.failOrFallback("custom", settings, command, args);
		}

		if (this.platform === "darwin") {
			const profileText = buildMacOsProfileText(name, this.workspaceRoot, settings.childNetwork);
			return {
				ok: true,
				wrapped: { command: "sandbox-exec", args: ["-p", profileText, "--", command, ...args] },
				profile: name,
				auditRequired: false,
			};
		}

		if (this.platform === "linux") {
			const bwrapArgs = buildBwrapArgs(name, this.workspaceRoot, settings.childNetwork);
			return {
				ok: true,
				wrapped: { command: "bwrap", args: [...bwrapArgs, "--", command, ...args] },
				profile: name,
				auditRequired: false,
			};
		}

		return this.failOrFallback(name, settings, command, args);
	}

	private failOrFallback(
		name: SandboxProfileName | "custom",
		settings: ResolvedSandboxSettings,
		command: string,
		args: string[],
	): SandboxBuildResult {
		const noBackend = `no sandbox backend is implemented for platform "${this.platform}" (supported: darwin, linux)`;
		if (settings.mode === "required") {
			return { ok: false, reason: `Sandboxing is required (mode="required") but ${noBackend}.`, profile: name };
		}
		if (name !== "custom" && ALWAYS_FAIL_CLOSED_WHEN_UNIMPLEMENTED.has(name)) {
			return {
				ok: false,
				reason: `Sandbox profile "${name}" cannot be enforced because ${noBackend}; failing closed rather than running unsandboxed.`,
				profile: name,
			};
		}
		// workspace/devbox/custom in best-effort mode: documented best-effort fallback, run unsandboxed.
		return { ok: true, wrapped: { command, args }, profile: name, auditRequired: false };
	}
}

export function isSupportedSandboxPlatform(platform: NodeJS.Platform = process.platform): boolean {
	return SANDBOXED_PLATFORMS.has(platform);
}
