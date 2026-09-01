import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition } from "./src/core/tools/bash.ts";
import { SandboxManager } from "./src/core/sandbox/sandbox-manager.ts";
import { resolveSandboxSettings } from "./src/core/sandbox/types.ts";

const dir = mkdtempSync(join(tmpdir(), "pi-sandbox-debug2-"));
console.log("workspaceRoot:", dir);
const manager = new SandboxManager({ workspaceRoot: dir });
const settings = resolveSandboxSettings({ profile: "workspace" });
const built = manager.build("bash", ["-c", "true"], settings);
console.log("built:", JSON.stringify(built, null, 2).slice(0, 2000));

const definition = createBashToolDefinition(dir, { exposeSessionEnvironment: false, sandbox: { manager, settings } });
const target = join(dir, "marker.txt");
try {
  const result = await definition.execute("call-1", { command: `touch ${target}` }, undefined, undefined, {});
  console.log("RESULT:", JSON.stringify(result));
} catch (e) {
  console.log("THROW:", e.message);
}
console.log("exists after:", existsSync(target));
