export interface ChangedFilesResult {
  files: Set<string>;
  forceAll: boolean;
  /** Why forceAll was set, when it was. */
  reason?: string;
  /** Whether the file set was truncated and could not be recovered. */
  truncated?: boolean;
}

/** Shared path routing for manual deployments and provider webhook events. */
const ROOT_CONFIG_FILES = new Set([
  "Dockerfile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  ".dockerignore",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "turbo.json",
  "turbo.jsonc",
  "openship.json",
  "nx.json",
  "rush.json",
  "tsconfig.json",
  "tsconfig.base.json",
  "Cargo.toml",
  "Cargo.lock",
  "go.work",
  "go.work.sum",
  "pyproject.toml",
  "uv.lock",
  "pom.xml",
  "settings.gradle",
  "settings.gradle.kts",
  "gradle.properties",
  "mix.exs",
  "mix.lock",
]);

function normalizeSharedPrefix(p: string): string {
  // Accept both "packages" and "packages/**"; normalize to "packages/".
  let s = p.trim();
  if (!s) return "";
  s = s.replace(/\*+$/g, ""); // strip trailing *'s
  s = s.replace(/\*+\/?$/g, "");
  if (!s.endsWith("/")) s += "/";
  return s;
}

/**
 * Decide whether a changed-files SET forces a full rebuild — independent of the
 * push payload, so it's shared by the webhook (payload path) and the manual
 * smart-redeploy path (compareCommits path). Mirrors steps 4–5 of
 * extractChangedFiles: a root-config file (Dockerfile/compose/package.json/…)
 * or a configured monorepo shared-path affects every service.
 */
export function classifyChangedFiles(
  files: Iterable<string>,
  opts: { isMonorepo?: boolean; monorepoSharedPaths?: string[] | null } = {},
): { forceAll: boolean; reason?: string } {
  for (const f of files) {
    if (ROOT_CONFIG_FILES.has(f)) {
      return { forceAll: true, reason: "root-config" };
    }
  }
  if (opts.isMonorepo && opts.monorepoSharedPaths && opts.monorepoSharedPaths.length > 0) {
    const prefixes = opts.monorepoSharedPaths.map(normalizeSharedPrefix).filter(Boolean);
    if (prefixes.length > 0) {
      for (const f of files) {
        if (prefixes.some((p) => f.startsWith(p))) {
          return { forceAll: true, reason: "shared-package" };
        }
      }
    }
  }
  return { forceAll: false };
}

/**
 * Route a changed-files set to the affected routable services. Shared by the
 * webhook and the manual smart-redeploy path so per-service targeting is
 * identical (no duplicated matching logic).
 *
 *   - { mode: "all" }     → no routable services (single-app) → rebuild it.
 *   - { mode: "services" }→ at least one service's rootDirectory changed.
 *   - { mode: "skip" }    → routable services exist but none were affected.
 */
export function routeServicesByChanges(
  routableServices: Array<{ id: string; rootDirectory: string | null }>,
  files: Iterable<string>,
): { mode: "all" } | { mode: "services"; serviceIds: string[] } | { mode: "skip" } {
  if (routableServices.length === 0) return { mode: "all" };
  const matched = routableServices
    .filter((s) => serviceMatchesChanges(s.rootDirectory, files))
    .map((s) => s.id);
  if (matched.length === 0) return { mode: "skip" };
  return { mode: "services", serviceIds: matched };
}

/**
 * Decide whether a service is affected by the given changed-files set.
 *
 * Matching rule: any file whose path starts with `${rootDirectory}/`
 * counts. A root-directory of `""` or `"."` means "the project IS the
 * service" — always matches.
 */
export function serviceMatchesChanges(
  rootDirectory: string | null | undefined,
  changedFiles: Iterable<string>,
): boolean {
  const root = (rootDirectory ?? "").trim();
  if (!root || root === ".") return true;
  const normalized = root.replace(/^\/+/, "").replace(/\/+$/, "");
  const prefix = `${normalized}/`;
  for (const f of changedFiles) {
    if (f === normalized || f.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Decide whether a commit can affect a project rooted below the repository root.
 * Besides files inside the project itself, repository-wide build inputs and the
 * project's explicitly configured shared paths are part of its effective build
 * context. Keeping this rule beside webhook routing prevents the update banner
 * and auto-deploy from disagreeing about the same change set.
 */
export function projectMatchesChanges(
  rootDirectory: string,
  changedFiles: Iterable<string>,
  monorepoSharedPaths?: string[] | null,
): boolean {
  const files = Array.from(changedFiles);
  if (serviceMatchesChanges(rootDirectory, files)) return true;
  return classifyChangedFiles(files, {
    isMonorepo: true,
    monorepoSharedPaths,
  }).forceAll;
}

/** Commit message override shared by provider push handlers. */
export const FORCE_DEPLOY_MESSAGE = /\[(force|force-deploy|redeploy-all)\]/i;
