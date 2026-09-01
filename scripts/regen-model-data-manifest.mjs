// Rebuild src/providers/data/.manifest.json against THIS checkout's generated
// catalog (models.generated.ts). Needed when the data JSONs are borrowed from
// a newer published package: extra providers must go and the manifest hashes
// must be recomputed with this version's own logic. models.dev being
// unreachable is what makes the borrow necessary in the first place.
//
// Usage: node scripts/regen-model-data-manifest.mjs
import { readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_DATA_MANIFEST_FILE,
  readModelDataProviderIds,
  readModelDataStructure,
  createModelDataManifest,
} from "../packages/ai/scripts/model-data.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "ai");
const dataDir = join(packageRoot, "src", "providers", "data");

const providerIds = new Set(readModelDataProviderIds(packageRoot));
for (const entry of readdirSync(dataDir)) {
  if (!entry.endsWith(".json") || entry === MODEL_DATA_MANIFEST_FILE) continue;
  const id = entry.replace(/\.json$/, "");
  if (!providerIds.has(id)) {
    console.log(`drop ${entry} (not in this checkout's catalog)`);
    rmSync(join(dataDir, entry));
  }
}

const structure = readModelDataStructure(packageRoot);
const fileContents = Object.fromEntries(
  Object.keys(structure).map((id) => [`${id}.json`, readFileSync(join(dataDir, `${id}.json`), "utf8")]),
);
const manifest = createModelDataManifest(structure, fileContents, new Date().toISOString());
writeFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest, null, "\t")}\n`);
console.log(`manifest rebuilt for ${Object.keys(structure).length} providers`);
