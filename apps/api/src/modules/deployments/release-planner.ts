/**
 * Single release planner for webhook, UI, CLI, and MCP.
 *
 * Classifies a change set into skip | deploy_code | refresh_config |
 * rebuild_runtime. Callers choose the trigger from `selectReleaseTrigger`:
 * mounted code releases only run for deploy_code while opted in.
 */

export type ReleaseAction = "skip" | "deploy_code" | "refresh_config" | "rebuild_runtime";

export type ReleaseTrigger = "skip" | "mounted_release" | "runtime_pipeline";

export interface ReleasePlan {
  action: ReleaseAction;
  reason: string;
  serviceIds?: string[];
}

export interface PlannerService {
  id: string;
  name: string;
  rootDirectory?: string | null;
}

export interface ServicePathPrefix {
  /** Logical key (`staff`) or a concrete service id. */
  key: string;
  prefixes: string[];
}

export interface PlanReleaseInput {
  /** Repo-relative paths. `null` = unknown (truncated compare, force-push, manual). */
  changedPaths: string[] | null;
  mountedReleaseEnabled: boolean;
  services?: PlannerService[];
  /** Override AE defaults (`apps/staff`, `apps/public`, `apps/mail`). */
  servicePathPrefixes?: ServicePathPrefix[];
  /** Existing webhook/smart-route targets — composed with prefix matches. */
  routedServiceIds?: string[];
  forceAll?: boolean;
  refreshRequested?: boolean;
}

/** AE monorepo defaults. Override via `servicePathPrefixes` on the recipe later. */
export const DEFAULT_SERVICE_PATH_PREFIXES: ServicePathPrefix[] = [
  { key: "staff", prefixes: ["apps/staff"] },
  { key: "public", prefixes: ["apps/public"] },
  { key: "mail", prefixes: ["apps/mail"] },
];

export function planAndSelectTrigger(input: PlanReleaseInput): {
  plan: ReleasePlan;
  trigger: ReleaseTrigger;
} {
  const plan = planRelease(input);
  return { plan, trigger: selectReleaseTrigger(plan, input.mountedReleaseEnabled) };
}

export function selectReleaseTrigger(
  plan: ReleasePlan,
  mountedReleaseEnabled: boolean,
): ReleaseTrigger {
  if (plan.action === "skip") return "skip";
  if (plan.action === "deploy_code" && mountedReleaseEnabled) return "mounted_release";
  return "runtime_pipeline";
}

export function planRelease(input: PlanReleaseInput): ReleasePlan {
  const prefixes = input.servicePathPrefixes ?? DEFAULT_SERVICE_PATH_PREFIXES;
  const services = input.services ?? [];
  const bound = prefixes.filter((spec) => services.some((s) => serviceMatchesPrefix(s, spec)));

  if (input.refreshRequested) {
    return {
      action: "refresh_config",
      reason: "Configuration refresh requested.",
      serviceIds: input.routedServiceIds,
    };
  }

  if (input.changedPaths == null) {
    const action: ReleaseAction = input.forceAll ? "rebuild_runtime" : "deploy_code";
    return {
      action,
      reason: input.forceAll
        ? "Changed paths are unknown and a full rebuild was requested."
        : "Changed paths are unknown; deploying application code.",
      serviceIds: input.forceAll ? undefined : input.routedServiceIds,
    };
  }

  const paths = input.changedPaths.map(normalizeRepoPath).filter(Boolean);
  if (paths.length === 0) {
    if (input.forceAll) {
      return {
        action: "rebuild_runtime",
        reason: "Force-all requested with no changed-path list; rebuild the runtime.",
      };
    }
    return { action: "skip", reason: "No changed files in this push." };
  }

  let sawRuntime = false;
  let sawPhpExt = false;
  let sawComposerLock = false;
  let sawCode = false;
  let sawConfig = false;

  for (const path of paths) {
    if (isRuntimePath(path)) {
      sawRuntime = true;
      if (isPhpExtensionPath(path)) sawPhpExt = true;
      continue;
    }
    if (isComposerLock(path)) {
      sawComposerLock = true;
      sawCode = true;
      continue;
    }
    if (isConfigPath(path)) {
      sawConfig = true;
      continue;
    }
    if (isSkipPath(path)) continue;
    if (bound.length > 0 && isUnrelatedAppPath(path, bound)) continue;
    sawCode = true;
  }

  let action: ReleaseAction;
  let reason: string;
  if (sawRuntime) {
    action = "rebuild_runtime";
    reason = sawPhpExt
      ? "PHP extensions configuration changed; rebuild the runtime image."
      : "Dockerfile or Compose changed; rebuild the runtime image.";
  } else if (sawCode) {
    action = "deploy_code";
    reason = sawComposerLock
      ? "composer.lock changed; deploy code and prepare the Composer layer."
      : "Application, Blade, or tracked asset files changed; deploy code.";
  } else if (sawConfig) {
    action = "refresh_config";
    reason = "Environment or route files changed; refresh configuration.";
  } else {
    action = "skip";
    reason = "Only documentation or unrelated monorepo paths changed.";
  }

  if (input.forceAll && action === "skip") {
    action = "rebuild_runtime";
    reason = "Force-all requested; changed paths would otherwise skip.";
  }

  const serviceIds =
    action === "skip"
      ? undefined
      : resolveTargetServiceIds(paths, {
          services,
          bound,
          routedServiceIds: input.routedServiceIds,
          forceAll: input.forceAll,
        });

  return { action, reason, ...(serviceIds?.length ? { serviceIds } : {}) };
}

function resolveTargetServiceIds(
  paths: string[],
  opts: {
    services: PlannerService[];
    bound: ServicePathPrefix[];
    routedServiceIds?: string[];
    forceAll?: boolean;
  },
): string[] | undefined {
  if (opts.bound.length === 0 || opts.services.length === 0) {
    return opts.forceAll ? undefined : opts.routedServiceIds;
  }

  const relevant = paths.filter(
    (path) => !isSkipPath(path) && !isUnrelatedAppPath(path, opts.bound),
  );

  const allUnderBound =
    relevant.length > 0 && relevant.every((path) => isUnderAnyPrefix(path, opts.bound));
  if (!allUnderBound) {
    return opts.forceAll ? undefined : opts.routedServiceIds;
  }

  const prefixIds: string[] = [];
  for (const spec of opts.bound) {
    if (!relevant.some((path) => spec.prefixes.some((prefix) => pathMatchesPrefix(path, prefix)))) {
      continue;
    }
    for (const service of opts.services) {
      if (serviceMatchesPrefix(service, spec) && !prefixIds.includes(service.id)) {
        prefixIds.push(service.id);
      }
    }
  }

  if (prefixIds.length && opts.routedServiceIds?.length) {
    const inter = opts.routedServiceIds.filter((id) => prefixIds.includes(id));
    return inter.length > 0 ? inter : prefixIds;
  }
  if (prefixIds.length) return prefixIds;
  return opts.forceAll ? undefined : opts.routedServiceIds;
}

function serviceMatchesPrefix(service: PlannerService, spec: ServicePathPrefix): boolean {
  if (service.id === spec.key) return true;
  const key = spec.key.trim().toLowerCase();
  const name = service.name.trim().toLowerCase();
  if (name === key) return true;
  const root = normalizeRepoPath(service.rootDirectory ?? "").toLowerCase();
  if (!root) return false;
  return spec.prefixes.some((prefix) => {
    const n = normalizeRepoPath(prefix).toLowerCase();
    return root === n || root.startsWith(`${n}/`);
  });
}

function normalizeRepoPath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/^\/+/, "");
}

function normalizePrefix(prefix: string): string {
  return normalizeRepoPath(prefix).replace(/\/+$/, "");
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  const n = normalizePrefix(prefix);
  return path === n || path.startsWith(`${n}/`);
}

function isUnderAnyPrefix(path: string, specs: ServicePathPrefix[]): boolean {
  return specs.some((spec) => spec.prefixes.some((prefix) => pathMatchesPrefix(path, prefix)));
}

function isUnrelatedAppPath(path: string, bound: ServicePathPrefix[]): boolean {
  if (!path.startsWith("apps/")) return false;
  return !isUnderAnyPrefix(path, bound);
}

function isComposerLock(path: string): boolean {
  return path === "composer.lock" || path.endsWith("/composer.lock");
}

function isPhpExtensionPath(path: string): boolean {
  if (/(^|\/)docker\/php(\/|$)/i.test(path)) return true;
  if (/php[-_.]?ext/i.test(path)) return true;
  if (/(^|\/)extensions\.ini$/i.test(path)) return true;
  if (/php/i.test(path) && /\/conf\.d\/.+\.ini$/i.test(path)) return true;
  return false;
}

function isRuntimePath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (/^Dockerfile(\.|$)/i.test(base)) return true;
  if (/^docker-compose\.(ya?ml)$/i.test(base)) return true;
  if (/^compose\.(ya?ml)$/i.test(base)) return true;
  if (base === ".dockerignore") return true;
  if (base.toLowerCase() === "php.ini") return true;
  if (isPhpExtensionPath(path)) return true;
  return false;
}

function isConfigPath(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  if (/^\.env($|\.(?!example$|sample$|dist$))/i.test(base)) return true;
  if (/^Caddyfile(\.|$)/i.test(base)) return true;
  if (/^nginx(\.conf|$)/i.test(base) || /\.nginx\.conf$/i.test(base)) return true;
  if (/^traefik\.(ya?ml|toml)$/i.test(base)) return true;
  if (/(^|\/)(routes|route)\.(ya?ml|json|toml)$/i.test(path)) return true;
  return false;
}

function isSkipPath(path: string): boolean {
  if (/(^|\/)docs?\//i.test(path)) return true;
  if (/(^|\/)\.github\//.test(path)) return true;
  const base = path.split("/").pop() ?? path;
  if (/^(README|CHANGELOG|CHANGES|LICENSE|CONTRIBUTING|CODE_OF_CONDUCT)(\.|$)/i.test(base)) {
    return true;
  }
  return /\.md$/i.test(base);
}
