/**
 * Regenerate the merged app catalog (`src/apps/catalog.json`) from the per-app
 * source files (`src/apps/catalog/*.json`). The merged file is what the bundle
 * imports and the API fetches remotely — one artifact, one request.
 *
 *   bun scripts/gen-catalog.ts
 *
 * Order is preserved from the existing catalog.json (curated / featured-first);
 * any NEW app file is appended alphabetically. A drift test asserts the
 * committed catalog.json matches this output, so editing a per-app file without
 * regenerating fails CI.
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const catalogDir = fileURLToPath(new URL("../src/apps/catalog/", import.meta.url));
const mergedPath = fileURLToPath(new URL("../src/apps/catalog.json", import.meta.url));

export function buildCatalog(): { version: number; apps: Array<{ id: string }> } {
  const existing = JSON.parse(readFileSync(mergedPath, "utf8")) as {
    version?: number;
    apps: Array<{ id: string }>;
  };
  const order = new Map(existing.apps.map((a, i) => [a.id, i] as const));
  const apps = readdirSync(catalogDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(catalogDir + f, "utf8")) as { id: string })
    .sort((a, b) => {
      const ai = order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const bi = order.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return ai !== bi ? ai - bi : a.id.localeCompare(b.id);
    });
  return { version: existing.version ?? 1, apps };
}

// Only writes when run directly (bun sets import.meta.main); a test that imports
// buildCatalog() must never rewrite the file.
if ((import.meta as { main?: boolean }).main) {
  writeFileSync(mergedPath, JSON.stringify(buildCatalog(), null, 2) + "\n");
  console.log("gen-catalog: catalog.json regenerated from apps/catalog/*.json");
}
