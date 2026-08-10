/**
 * Persistent storage for a SINGLE-APP project.
 *
 * Compose services have always been able to declare `volumes` (raw compose
 * syntax, `name:/container/path`). App stacks could not — so every redeploy of a
 * detected app threw away whatever the app had written. That is silent for the
 * frameworks whose stock defaults write to disk: a Laravel app keeps uploads,
 * sessions, cache and (on stock settings) its whole SQLite database under
 * `storage/`, boots fine on a fresh volume, and looks healthy while the previous
 * release's data is gone.
 *
 * This module is the app-side half of that story. It accepts the same compose
 * strings the service path takes, plus the shorter form an app actually wants —
 * a bare path relative to the app root (`storage`) — and expands it to a real
 * spec. Docker volume NAMING is not here: `runtime/volume-namespace.ts` in
 * @repo/adapters is the single authority for the `openship-<slug>-` scoping, and
 * both the single-app and multi-service deploys go through it.
 *
 * Pure string logic, no dependencies.
 */

import { STACKS, type StackDefinition, type StackId } from "./stacks";

/** Where a generated app image puts the application. Mirrors the WORKDIR the
 *  Docker recipes write (`docker-build-plan.ts`). */
export const APP_DIR = "/app";

/** Trailing bind-mode suffix (`:ro` / `:rw` / SELinux / nocopy) — same set the
 *  volume namespacer and the backup classifier recognise. */
const MODE_SUFFIX = /:(ro|rw|z|Z|nocopy)$/;

/**
 * Volume name for a bare app path: `storage/app` → `storage-app`. Only the
 * characters Docker accepts in a volume name survive; the result is later
 * prefixed with `openship-<slug>-` at container-create time, so it just has to
 * be stable and readable, not globally unique.
 */
export function volumeAutoName(path: string): string {
  const cleaned = path
    .trim()
    .replace(/^\.\//, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "data";
}

/**
 * Expand ONE declared volume into a compose-syntax spec.
 *
 * A bare path — the form an app declares, `storage` or `/app/storage` — becomes
 * `<autoname>:<absolute target>`. Anything already in `source:target` form (a
 * named volume or a host bind mount) passes through untouched, so a user who
 * wants a bind mount or a shared volume name keeps full control. Returns null
 * for input that can't be a mount (empty, or a target outside the app dir given
 * as a relative path that normalises away).
 */
export function normalizeAppVolume(spec: string, appDir: string = APP_DIR): string | null {
  const raw = spec.trim();
  if (!raw) return null;

  const modeMatch = raw.match(MODE_SUFFIX);
  const mode = modeMatch ? modeMatch[0] : "";
  const body = mode ? raw.slice(0, -mode.length) : raw;

  // Already `source:target` (2 segments, or 3 on Windows-style `C:\x:/y`).
  if (body.split(":").length >= 2) return raw;

  const path = body.replace(/^\.\//, "").replace(/\/+$/g, "");
  if (!path) return null;
  const target = path.startsWith("/") ? path : `${appDir.replace(/\/+$/, "")}/${path}`;
  // The auto-name is derived from the path RELATIVE to the app dir, so
  // `storage` and `/app/storage` produce the same volume — declaring it either
  // way must not create a second, empty volume.
  const relative = target.startsWith(`${appDir}/`) ? target.slice(appDir.length + 1) : target;
  return `${volumeAutoName(relative)}:${target}${mode}`;
}

/** Expand a declared list, dropping unusable entries and duplicate targets. */
export function normalizeAppVolumes(specs: readonly string[], appDir: string = APP_DIR): string[] {
  const out: string[] = [];
  const seenTargets = new Set<string>();
  for (const spec of specs) {
    const normalized = normalizeAppVolume(spec, appDir);
    if (!normalized) continue;
    const withoutMode = normalized.replace(MODE_SUFFIX, "");
    const target = withoutMode.slice(withoutMode.indexOf(":") + 1);
    if (seenTargets.has(target)) continue;
    seenTargets.add(target);
    out.push(normalized);
  }
  return out;
}

/**
 * The stack's own persistence defaults — what a stock app of this framework
 * writes at runtime and would otherwise lose. Zero-config: a project that never
 * touches its storage settings still keeps its data across deploys.
 */
export function resolveStackVolumes(stackId: string | null | undefined): string[] {
  if (!stackId || !(stackId in STACKS)) return [];
  const stack = STACKS[stackId as StackId] as StackDefinition;
  if (!stack.persistentPaths?.length) return [];
  return normalizeAppVolumes(stack.persistentPaths);
}

/**
 * The volumes a project deploys with: its own declaration when it has one, else
 * the stack default. An EMPTY array is a real answer (the user turned storage
 * off) — only null/undefined falls back, mirroring how `productionPaths`
 * resolves against the stack registry.
 */
export function resolveProjectVolumes(
  declared: readonly string[] | null | undefined,
  framework: string | null | undefined,
): string[] {
  if (declared) return normalizeAppVolumes(declared);
  return resolveStackVolumes(framework);
}

/** Container-side mount targets, relative to the app dir — what the bare runtime
 *  needs (it symlinks release paths into a shared dir instead of mounting). */
export function appVolumeTargets(volumes: readonly string[], appDir: string = APP_DIR): string[] {
  const out: string[] = [];
  for (const spec of volumes) {
    const body = spec.replace(MODE_SUFFIX, "");
    const idx = body.indexOf(":");
    if (idx < 0) continue;
    const target = body.slice(idx + 1);
    if (!target.startsWith(`${appDir}/`)) continue;
    out.push(target.slice(appDir.length + 1));
  }
  return out;
}
