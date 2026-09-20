/**
 * Path sandboxing for `kind: 'local'` backup destinations.
 *
 * Split out of destination.service.ts so the rules are testable without the
 * DB/adapter graph and so the root is validated by the same code on create and
 * on PATCH. The env-level gates (cloud mode, BACKUP_ALLOW_LOCAL_DESTINATION)
 * stay in the service — this module only answers "is this path allowed".
 */

import path from "node:path";
import { realpath } from "node:fs/promises";

/**
 * System trees `BACKUP_LOCAL_ROOT` must never point at. Checked against the
 * ROOT, not the endpoint: an endpoint is already sandboxed by the containment
 * check, and the root is the sandbox the operator deliberately configured.
 *
 * Checking the ENDPOINT against this list is what broke local destinations
 * entirely — the default root (/var/lib/openship/backups) sits under
 * /var/lib/openship, so every default-config path was rejected and the
 * containment check below was unreachable.
 */
const LOCAL_ROOT_DENY_PREFIX = [
  "/etc",
  "/proc",
  "/sys",
  "/dev",
  "/root",
  "/boot",
  "/var/lib/postgresql",
  "/var/lib/docker",
];

/**
 * Roots too broad to be a backup sandbox, plus Openship's own state directory.
 * Exact match only — the DEFAULT root lives *inside* /var/lib/openship, so a
 * prefix rule here would reject every install.
 */
const LOCAL_ROOT_DENY_EXACT = ["/", "/var", "/var/lib", "/var/lib/openship"];

/**
 * Resolve symlinks as deeply as the filesystem allows. realpath() fails when
 * the leaf doesn't exist yet, so fall back to the closest existing ancestor
 * plus the remainder — sufficient, because writes go through fs.mkdir later
 * and a not-yet-existing path cannot hide a symlink we'd otherwise catch.
 */
async function resolveDeep(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    let parent = target;
    while (parent !== path.dirname(parent)) {
      parent = path.dirname(parent);
      try {
        const real = await realpath(parent);
        return path.join(real, target.slice(parent.length));
      } catch {
        // keep walking up
      }
    }
    return target;
  }
}

/**
 * The deny lists with every entry symlink-resolved, computed once.
 *
 * Needed because on macOS `/etc` and `/var` are symlinks into `/private`, so a
 * resolved root reads `/private/var/lib/docker` and matches no literal entry —
 * comparing only resolved paths against literal entries disables the deny list
 * outright on darwin (the API runs there in desktop mode).
 */
let resolvedDenyLists: Promise<{ exact: string[]; prefix: string[] }> | null = null;

function denyLists(): Promise<{ exact: string[]; prefix: string[] }> {
  resolvedDenyLists ??= (async () => ({
    exact: await Promise.all(LOCAL_ROOT_DENY_EXACT.map((p) => resolveDeep(p))),
    prefix: await Promise.all(LOCAL_ROOT_DENY_PREFIX.map((p) => resolveDeep(p))),
  }))();
  return resolvedDenyLists;
}

function assertNotDenied(
  candidate: string,
  lists: { exact: string[]; prefix: string[] },
): void {
  if (lists.exact.includes(candidate)) {
    throw new Error(
      `BACKUP_LOCAL_ROOT (${candidate}) is not a valid backup root. Point it at a dedicated directory.`,
    );
  }
  for (const denied of lists.prefix) {
    if (candidate === denied || candidate.startsWith(denied + path.sep)) {
      throw new Error(
        `BACKUP_LOCAL_ROOT (${candidate}) is inside a protected system directory (${denied}).`,
      );
    }
  }
}

/**
 * Resolve BACKUP_LOCAL_ROOT and refuse a dangerous one.
 *
 * Both the path as written AND its symlink-resolved form are screened, each
 * against like-for-like deny entries: the written form catches a root typed as
 * `/etc/backups`, the resolved form catches one symlinked there.
 */
export async function resolveLocalBackupRoot(rootSetting: string): Promise<string> {
  if (!rootSetting.trim()) {
    throw new Error("BACKUP_LOCAL_ROOT is not configured");
  }
  if (!path.isAbsolute(rootSetting)) {
    throw new Error("BACKUP_LOCAL_ROOT must be an absolute path");
  }
  const requested = path.resolve(rootSetting);
  const resolved = await resolveDeep(requested);
  const lists = await denyLists();

  assertNotDenied(requested, { exact: LOCAL_ROOT_DENY_EXACT, prefix: LOCAL_ROOT_DENY_PREFIX });
  if (resolved !== requested) assertNotDenied(resolved, lists);

  return resolved;
}

/**
 * Assert `endpoint` resolves inside `rootSetting` and return the resolved path.
 * Both sides are symlink-resolved before comparison, so a symlink pointing out
 * of the root is rejected.
 */
export async function assertLocalEndpointInRoot(
  endpoint: string,
  rootSetting: string,
): Promise<string> {
  if (!path.isAbsolute(endpoint)) {
    throw new Error("Local destination path must be absolute");
  }
  const root = await resolveLocalBackupRoot(rootSetting);
  const resolved = await resolveDeep(path.resolve(endpoint));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Local destination must be inside BACKUP_LOCAL_ROOT (${root})`);
  }
  return resolved;
}
