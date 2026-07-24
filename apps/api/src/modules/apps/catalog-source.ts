import { APP_TEMPLATES, isValidAppTemplate, type AppTemplate } from "@repo/core";

/**
 * Runtime app catalog = the BUNDLED catalog (`@repo/core` APP_TEMPLATES) overlaid
 * by a repo-fetched copy, so a new/updated app in the repo appears AND installs
 * on existing instances without a redeploy. Stale-while-revalidate + fail-safe:
 * `getRuntimeCatalog()` is synchronous (every consumer stays sync) — it returns
 * the current cache and kicks a background refresh when stale. Any fetch/parse
 * failure or an offline box simply keeps serving the last-good/bundled catalog,
 * so the overlay can never break the catalog.
 *
 * Trust: the source is our own repo over HTTPS (chosen scope — repo-curated, no
 * signing, no user uploads). Each remote entry is shape-validated
 * (`isValidAppTemplate`) before it can drive an install; a bundled app is never
 * dropped even if the remote omits/invalidates it.
 */

const REMOTE_URL =
  "https://raw.githubusercontent.com/oblien/openship/main/packages/core/src/apps/catalog.json";
const TTL_MS = 600_000; // 10 minutes

let cache: readonly AppTemplate[] = APP_TEMPLATES; // seed with bundled
let cachedAt = 0;
let refreshing = false;

/** Remote entries (validated) + any bundled app the remote dropped — remote wins. */
function mergeById(remote: AppTemplate[]): AppTemplate[] {
  const remoteIds = new Set(remote.map((r) => r.id));
  const bundledOnly = APP_TEMPLATES.filter((b) => !remoteIds.has(b.id));
  return [...remote, ...bundledOnly];
}

async function fetchRemote(): Promise<AppTemplate[] | null> {
  try {
    const res = await fetch(REMOTE_URL, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const body = (await res.json()) as { apps?: unknown };
    if (!Array.isArray(body?.apps)) return null;
    const valid = body.apps.filter(isValidAppTemplate) as AppTemplate[];
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

function refresh(): void {
  if (refreshing) return;
  refreshing = true;
  void fetchRemote()
    .then((remote) => {
      if (remote) cache = mergeById(remote);
      cachedAt = Date.now();
    })
    .catch(() => {
      /* keep last-good */
    })
    .finally(() => {
      refreshing = false;
    });
}

/** The current app catalog (bundled ∪ repo overlay). Sync; refreshes in the
 *  background when the cache is older than the TTL. */
export function getRuntimeCatalog(): readonly AppTemplate[] {
  if (Date.now() - cachedAt > TTL_MS) refresh();
  return cache;
}

/** One app by id from the runtime catalog (tolerates a null/undefined id). */
export function getRuntimeTemplate(id: string | null | undefined): AppTemplate | undefined {
  if (!id) return undefined;
  return getRuntimeCatalog().find((t) => t.id === id);
}

// Warm the overlay at boot so instances pick up repo changes promptly.
refresh();
