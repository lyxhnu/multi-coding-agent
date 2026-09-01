/**
 * Grok-aligned sandbox configuration (spec 12). Profiles and their exact enforcement semantics; the
 * actual OS-level backend lives in sandbox-manager.ts.
 */

export type SandboxProfileName = "workspace" | "devbox" | "read-only" | "strict" | "off";
export type SandboxProfile = SandboxProfileName | { custom: string };
export type SandboxMode = "best-effort" | "required";
export type ChildNetworkPolicy = "unrestricted" | "blocked" | "websites";

export interface SandboxSettings {
	profile?: SandboxProfile; // default: "workspace"
	mode?: SandboxMode; // default: "best-effort"
	childNetwork?: ChildNetworkPolicy; // default: "unrestricted" unless a caller (e.g. diagnostics) overrides it
}

export interface ResolvedSandboxSettings {
	profile: SandboxProfile;
	mode: SandboxMode;
	childNetwork: ChildNetworkPolicy;
}

export const DEFAULT_SANDBOX_SETTINGS: ResolvedSandboxSettings = {
	profile: "workspace",
	mode: "best-effort",
	childNetwork: "unrestricted",
};

export function resolveSandboxSettings(settings: SandboxSettings | undefined): ResolvedSandboxSettings {
	return {
		profile: settings?.profile ?? DEFAULT_SANDBOX_SETTINGS.profile,
		mode: settings?.mode ?? DEFAULT_SANDBOX_SETTINGS.mode,
		childNetwork: settings?.childNetwork ?? DEFAULT_SANDBOX_SETTINGS.childNetwork,
	};
}

export function profileName(profile: SandboxProfile): SandboxProfileName | "custom" {
	return typeof profile === "string" ? profile : "custom";
}
