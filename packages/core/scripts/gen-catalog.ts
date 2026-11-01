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
import { readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AppTemplate } from "../src/app-templates";

const catalogDir = fileURLToPath(new URL("../src/apps/catalog/", import.meta.url));
const mergedPath = fileURLToPath(new URL("../src/apps/catalog.json", import.meta.url));

export function compileAppArticle(app: AppTemplate): AppTemplate {
  const file = app.marketplace?.articleFile;
  if (!file) return app;
  if (!/^articles\/[a-z0-9][a-z0-9-]*\.md$/.test(file))
    throw new Error(`${app.id}: articleFile must be articles/<slug>.md`);
  if (app.marketplace?.article !== undefined)
    throw new Error(`${app.id}: choose article or articleFile, not both`);
  const root = realpathSync(resolve(catalogDir, "articles"));
  const path = realpathSync(resolve(catalogDir, file));
  if (!path.startsWith(root + sep)) throw new Error(`${app.id}: article escapes catalog/articles`);
  const { articleFile: _, ...content } = app.marketplace!;
  return { ...app, marketplace: { ...content, article: readFileSync(path, "utf8").trim() } };
}

export function buildCatalog(): { version: number; apps: AppTemplate[] } {
  const existing = JSON.parse(readFileSync(mergedPath, "utf8")) as {
    version?: number;
    apps: Array<{ id: string }>;
  };
  const order = new Map(existing.apps.map((a, i) => [a.id, i] as const));
  const apps = readdirSync(catalogDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => compileAppArticle(JSON.parse(readFileSync(catalogDir + f, "utf8")) as AppTemplate))
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
