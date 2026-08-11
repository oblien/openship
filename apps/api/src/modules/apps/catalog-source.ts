import {
  APP_TEMPLATES,
  isValidAppTemplate,
  parseAppTemplate,
  templateEngineOk,
  type AppTemplate,
} from "@repo/core";
import { repos } from "@repo/db";
import { readApiVersion } from "../../lib/release-dist";

/**
 * Runtime app catalog = the BUNDLED catalog (`@repo/core` APP_TEMPLATES) overlaid
 * by a repo-fetched copy, so a new/updated app in the repo appears AND installs
 * on existing instances without a redeploy. Stale-while-revalidate + fail-safe:
 * `getRuntimeCatalog()` is synchronous (every consumer stays sync) — it returns
 * the current cache and kicks a background refresh when stale. Any fetch/parse
 * failure or an offline box simply keeps serving the last-good/bundled catalog,
 * so the overlay can never break the catalog.
 *
 * Versioning (the overlay can be AHEAD of this instance): each entry declares an
 * optional `minEngine`. Resolution never silently drops a too-new app — instead:
 *   - engine ok                         → the overlay entry (remote-wins).
 *   - too new, but bundled copy is ok    → serve the BUNDLED copy (no break),
 *                                          flagged `updateAvailable`.
 *   - too new, no runnable copy          → a guided `requiresUpdate` PLACEHOLDER
 *                                          ("Requires Openship ≥ X"), not installable.
 * `schemaVersion` (an unreadable future SHAPE) is still dropped at ingest, but a
 * best-effort placeholder is surfaced when the raw entry's identity is readable.
 *
 * Trust: the source is our own repo over HTTPS (repo-curated, no signing, no user
 * uploads); every entry is shape-validated before it can drive an install.
 */

const REMOTE_URL =
  "https://raw.githubusercontent.com/oblien/openship/main/packages/core/src/apps/catalog.json";
const TTL_MS = 600_000; // 10 minutes
/** Catalog-ENVELOPE version we know how to read (the top-level `version`). A
 *  newer envelope is logged, not fatal — entries are gated individually. */
const MAX_CATALOG_VERSION = 1;

/** A resolved catalog entry: a template, possibly a lightweight placeholder that
 *  needs a newer Openship to install. */
export type ResolvedAppTemplate = AppTemplate & {
  /** Set when this id needs a newer Openship than this instance — not installable. */
  requiresUpdate?: { minVersion?: string };
  /** A newer (engine-gated) version exists in the overlay; the bundled copy is served. */
  updateAvailable?: boolean;
  /** A per-org user-uploaded app — always unverified (provenance-based trust). */
  custom?: boolean;
};

/** This instance's Openship version, for the `minEngine` gate.
 *
 *  Kept defensive, but note it no longer throws: `readApiVersion()` used to read
 *  package.json off disk, which threw inside the desktop's compiled binary — so
 *  this catch was silently disabling the `minEngine` gate for every desktop
 *  install. It now returns the version embedded at build time, and the gate is
 *  live on desktop too. */
function engineVersion(): string | undefined {
  try {
    return readApiVersion();
  } catch {
    return undefined;
  }
}

/** Bundled apps that pass the shape gate — the single validation path applied to
 *  the trusted set too, so a hand-edited bad bundled entry is caught at runtime. */
const bundledValid: readonly AppTemplate[] = APP_TEMPLATES.filter((app) => {
  if (isValidAppTemplate(app)) return true;
  console.warn(`[catalog] bundled app "${(app as { id?: string }).id ?? "?"}" failed shape validation — skipping`);
  return false;
});
const bundledById = new Map(bundledValid.map((b) => [b.id, b]));

/** Best-effort identity placeholder from a raw entry we couldn't fully parse
 *  (a too-new SHAPE) — the top-level identity fields are stable across schema
 *  versions, so a "requires update" card can still be shown. Null if unreadable. */
function placeholderFromRaw(raw: unknown): ResolvedAppTemplate | null {
  const r = raw as Record<string, unknown> | null;
  if (
    !r ||
    typeof r.id !== "string" ||
    typeof r.name !== "string" ||
    typeof r.description !== "string" ||
    typeof r.logo !== "string" ||
    typeof r.category !== "string"
  ) {
    return null;
  }
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    kind: r.kind === "flow" ? "flow" : "template",
    logo: r.logo,
    category: r.category as AppTemplate["category"],
    available: false,
    requiresUpdate: { minVersion: typeof r.minEngine === "string" ? r.minEngine : undefined },
  };
}

/** A guided "requires update" placeholder from a validated (but too-new) template. */
function placeholder(entry: AppTemplate): ResolvedAppTemplate {
  return {
    id: entry.id,
    name: entry.name,
    description: entry.description,
    kind: entry.kind,
    logo: entry.logo,
    category: entry.category,
    available: false,
    requiresUpdate: { minVersion: entry.minEngine },
  };
}

/**
 * Resolve the effective catalog for this instance: remote-wins union of bundled
 * + overlay ids, then the engine gate with bundled fallback / guided placeholder.
 * `tooNewRaw` are placeholders for entries whose SHAPE was too new to parse.
 */
export function resolveCatalog(
  remote: readonly AppTemplate[],
  tooNewRaw: readonly ResolvedAppTemplate[],
  engine: string | undefined = engineVersion(),
): ResolvedAppTemplate[] {
  const byId = new Map<string, AppTemplate>();
  for (const b of bundledValid) byId.set(b.id, b);
  for (const r of remote) byId.set(r.id, r); // remote wins

  const out: ResolvedAppTemplate[] = [];
  for (const [id, entry] of byId) {
    if (templateEngineOk(entry.minEngine, engine)) {
      out.push(entry);
      continue;
    }
    // The winning entry needs a newer engine — fall back to a runnable bundled
    // copy if there is one, else surface a guided placeholder.
    const bundled = bundledById.get(id);
    if (bundled && templateEngineOk(bundled.minEngine, engine)) {
      out.push({ ...bundled, updateAvailable: true });
    } else {
      out.push(placeholder(entry));
    }
  }
  // Brand-new apps whose SHAPE was too new to parse AND aren't bundled — show a
  // "requires update" card rather than nothing.
  for (const p of tooNewRaw) {
    if (!byId.has(p.id)) out.push(p);
  }
  return out;
}

let cache: readonly ResolvedAppTemplate[] = resolveCatalog([], []);
let cachedAt = 0;
let refreshing = false;

async function fetchRemote(): Promise<{ entries: AppTemplate[]; tooNew: ResolvedAppTemplate[] } | null> {
  try {
    const res = await fetch(REMOTE_URL, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { apps?: unknown; version?: unknown };
    if (!Array.isArray(body?.apps)) return null;
    if (typeof body.version === "number" && body.version > MAX_CATALOG_VERSION) {
      console.warn(`[catalog] overlay catalog version ${body.version} is newer than known (${MAX_CATALOG_VERSION}); ingesting per-entry anyway`);
    }
    // Ingest is SHAPE + schemaVersion only (no engine gate — that's the resolver's
    // job, so a too-new-engine app can fall back / guide instead of vanishing).
    // Keep the RAW object for accepted entries so forward-added fields survive.
    const entries: AppTemplate[] = [];
    const tooNew: ResolvedAppTemplate[] = [];
    for (const app of body.apps) {
      const decision = parseAppTemplate(app);
      if (decision.ok) {
        entries.push(app as AppTemplate);
      } else if (decision.reason === "schema-too-new") {
        const p = placeholderFromRaw(app);
        if (p) tooNew.push(p);
        else console.warn(`[catalog] dropping overlay app — schema too new + unreadable identity`);
      } else {
        const id = (app as { id?: string })?.id ?? "?";
        console.warn(`[catalog] dropping overlay app "${id}" — invalid shape${decision.detail ? `: ${decision.detail}` : ""}`);
      }
    }
    return entries.length > 0 || tooNew.length > 0 ? { entries, tooNew } : null;
  } catch {
    return null;
  }
}

function refresh(): void {
  if (refreshing) return;
  refreshing = true;
  void fetchRemote()
    .then((remote) => {
      if (remote) cache = resolveCatalog(remote.entries, remote.tooNew);
      cachedAt = Date.now();
    })
    .catch(() => {
      /* keep last-good */
    })
    .finally(() => {
      refreshing = false;
    });
}

/** The current app catalog (bundled ∪ repo overlay, engine-resolved). Sync;
 *  refreshes in the background when the cache is older than the TTL. */
export function getRuntimeCatalog(): readonly ResolvedAppTemplate[] {
  if (Date.now() - cachedAt > TTL_MS) refresh();
  return cache;
}

/** One app by id from the CURATED runtime catalog (bundled ∪ overlay). May be a
 *  `requiresUpdate` placeholder — callers gate install on that. Org-agnostic;
 *  use `getTemplateForOrg` when a per-org custom app should also resolve. */
export function getRuntimeTemplate(id: string | null | undefined): ResolvedAppTemplate | undefined {
  if (!id) return undefined;
  return getRuntimeCatalog().find((t) => t.id === id);
}

/** An org's custom (user-uploaded) apps as catalog entries — always unverified
 *  (provenance-based trust; the stored `verified` is ignored). */
export async function listOrgCustomApps(organizationId: string): Promise<ResolvedAppTemplate[]> {
  const rows = await repos.customAppTemplate.listByOrg(organizationId);
  return rows.map((r) => ({ ...r.template, verified: false, custom: true }));
}

/** Resolve a template by id FOR AN ORG: the curated catalog first, else the
 *  org's custom app. Curated wins (a custom app can never shadow a verified id —
 *  enforced at upload too). Custom apps are forced unverified. */
export async function getTemplateForOrg(
  organizationId: string,
  id: string | null | undefined,
): Promise<ResolvedAppTemplate | undefined> {
  if (!id) return undefined;
  const curated = getRuntimeTemplate(id);
  if (curated) return curated;
  const custom = await repos.customAppTemplate.findByAppId(organizationId, id);
  return custom ? { ...custom.template, verified: false, custom: true } : undefined;
}

// Warm the overlay at boot so instances pick up repo changes promptly. Skipped
// under vitest so importing the module never fires a real network fetch.
if (!process.env.VITEST) refresh();
