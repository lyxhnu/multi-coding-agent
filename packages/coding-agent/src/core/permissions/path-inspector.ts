import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

/**
 * Path safety checks for the permission layer (see M1 hard-deny list:
 * "symlink/path traversal 逃逸"). This complements, but is not, a sandbox:
 * it only informs allow/ask/deny decisions before a tool runs.
 */
export interface PathInspection {
	/** Absolute, `..`-resolved path as requested (before symlink resolution). */
	resolvedPath: string;
	/** Canonical (symlinks resolved) path of the nearest existing ancestor, joined with the remaining segments. */
	canonicalPath: string;
	/** True if any existing ancestor is a symlink that escapes `scopeRoot`. */
	escapesScope: boolean;
}

/** Resolve `inputPath` against `cwd`, then canonicalize through symlinks on whatever prefix already exists. */
export function inspectPath(inputPath: string, cwd: string): PathInspection {
	const resolvedPath = isAbsolute(inputPath) ? resolve(inputPath) : resolve(cwd, inputPath);

	let existingAncestor = resolvedPath;
	const remaining: string[] = [];
	while (!existsSync(existingAncestor)) {
		const parent = dirname(existingAncestor);
		if (parent === existingAncestor) break; // reached filesystem root without finding an existing ancestor
		remaining.unshift(basename(existingAncestor));
		existingAncestor = parent;
	}

	let canonicalAncestor = existingAncestor;
	try {
		if (existsSync(existingAncestor)) {
			canonicalAncestor = realpathSync(existingAncestor);
		}
	} catch {
		// Best-effort: if realpath fails (permissions, race), fall back to the unresolved ancestor.
	}

	const canonicalPath = remaining.length > 0 ? resolve(canonicalAncestor, ...remaining) : canonicalAncestor;

	return {
		resolvedPath,
		canonicalPath,
		escapesScope: false, // filled in by `isWithinScope` callers; kept separate so callers choose the scope root.
	};
}

/** True if `canonicalPath` is inside `scopeRoot` (also canonicalized) — the actual symlink-aware containment check. */
export function isWithinScope(canonicalPath: string, scopeRoot: string): boolean {
	let canonicalScopeRoot = scopeRoot;
	try {
		if (existsSync(scopeRoot)) canonicalScopeRoot = realpathSync(scopeRoot);
	} catch {
		// Fall back to the unresolved scope root.
	}
	const normalizedPath = resolve(canonicalPath);
	const normalizedScope = resolve(canonicalScopeRoot);
	const pathFromScope = relative(normalizedScope, normalizedPath);
	return pathFromScope === "" || (!pathFromScope.startsWith("..") && !isAbsolute(pathFromScope));
}

/** Convenience: resolve+canonicalize `inputPath` and check it stays within `scopeRoot`. */
export function isPathWithinScope(inputPath: string, cwd: string, scopeRoot: string): boolean {
	const inspection = inspectPath(inputPath, cwd);
	return isWithinScope(inspection.canonicalPath, scopeRoot);
}

/**
 * True if `inputPath` ultimately resolves (through any symlinks along the way, including ones that
 * don't exist yet) outside `scopeRoot`. Deliberately delegates to the same canonicalization
 * `isPathWithinScope` uses rather than inspecting each ancestor in isolation: ancestors *above*
 * scopeRoot are routinely reached through a symlink on real filesystems (e.g. macOS's /tmp -> /private/tmp,
 * /var -> /private/var) and are not, by themselves, an escape — only the final resolved destination matters.
 */
export function hasSymlinkEscape(inputPath: string, cwd: string, scopeRoot: string): boolean {
	return !isPathWithinScope(inputPath, cwd, scopeRoot);
}
