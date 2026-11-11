/**
 * Resolve `catalog:` deps in Zero's vendored package.json files.
 *
 * Zero (`@zero/server`, `@zero/mail`) was extracted from its upstream pnpm
 * monorepo. Its package.json files contain `"foo": "catalog:"` references
 * that expect a pnpm-workspace.yaml `catalogs:` block we don't have.
 *
 * This script rewrites every such reference to a concrete version, in-place.
 * Run it once after extraction (or any time we re-pull Zero upstream).
 *
 * Versions chosen to match openship's existing pinned versions where the dep
 * is shared (drizzle, react, zod, typescript), and to recent stable releases
 * for Zero-specific deps (tRPC, wrangler, autumn-js).
 *
 * Usage:
 *   bun --cwd apps/email run resolve-catalogs
 */

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

// ─── Catalog ───────────────────────────────────────────────────────────────

const CATALOG: Record<string, string> = {
  // tRPC v11 (current stable, matches Zero's intent)
  "@trpc/client": "^11.4.4",
  "@trpc/server": "^11.4.4",
  "@trpc/tanstack-react-query": "^11.4.4",

  // Auth - same as the rest of openship
  "better-auth": "1.7.15",

  // ORM - pinned to match openship's packages/db + packages/db-email
  "drizzle-orm": "^0.45.1",
  "drizzle-kit": "^0.31.9",

  // UI - same as openship's dashboard
  react: "~19.2.9",
  "react-dom": "~19.2.9",
  typescript: "^5.9.3",

  // Validation - same as openship's packages/core
  zod: "^4.6.7",

  // Cloudflare Workers tooling
  wrangler: "^4.40.0",

  // JSON serialization for tRPC
  superjson: "^2.2.2",

  // Zero-specific billing/pricing - recent stable
  "autumn-js": "^0.1.6",
};

// ─── Rewriter ──────────────────────────────────────────────────────────────

async function rewriteCatalogRefs(packageJsonPath: string): Promise<void> {
  const raw = await readFile(packageJsonPath, "utf-8");
  const pkg = JSON.parse(raw) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };

  const sections = [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies];
  const unresolved: string[] = [];
  let resolvedCount = 0;

  for (const deps of sections) {
    if (!deps) continue;
    for (const [name, version] of Object.entries(deps)) {
      if (version !== "catalog:" && !version.startsWith("catalog:")) continue;
      const concrete = CATALOG[name];
      if (!concrete) {
        unresolved.push(name);
        continue;
      }
      deps[name] = concrete;
      resolvedCount++;
    }
  }

  if (unresolved.length > 0) {
    console.error(
      `\n  ✗ ${packageJsonPath}\n  Unknown catalog refs (add to CATALOG map above): ${unresolved.join(", ")}\n`,
    );
    process.exit(1);
  }

  // Preserve trailing newline if present.
  const trailingNewline = raw.endsWith("\n") ? "\n" : "";
  await writeFile(
    packageJsonPath,
    JSON.stringify(pkg, null, 2) + trailingNewline,
    "utf-8",
  );
  console.log(`  ✓ ${packageJsonPath} - resolved ${resolvedCount} catalog refs`);
}

// ─── Entry ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const here = new URL(".", import.meta.url).pathname;
  const emailDir = resolve(here, "..");
  console.log("Resolving Zero catalog references against the openship catalog map:");
  await rewriteCatalogRefs(resolve(emailDir, "server", "package.json"));
  await rewriteCatalogRefs(resolve(emailDir, "client", "package.json"));
  console.log("\nNext step: `cd server && bun install`  (then same for client)\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
