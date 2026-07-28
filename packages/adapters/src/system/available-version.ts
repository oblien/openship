/**
 * Package-manager "is a newer version available?" probe for installed infra
 * components (git / OpenResty / certbot / rsync). Read-only, uses the LOCAL
 * package index (no `apt-get update` / no root), so it's fast and safe to run on
 * a health check — it reports whatever the last index refresh knows, and
 * under-reports (never false-positives) when the index is stale.
 *
 * Best-effort by design: any probe/parse failure yields null, so a component
 * simply shows no "update available" rather than erroring the whole check.
 * apt is first-class (the common case); dnf/yum/apk are best-effort.
 */

import { compareSemver } from "@repo/core";
import type { CommandExecutor } from "../types";
import type { EnvironmentProfile } from "./environment";
import type { ComponentStatus } from "./types";

/** Component name → OS package name. null = not a tracked package (e.g. docker
 *  is installed via get.docker.com, not a repo package we can query). */
const PACKAGE_NAMES: Record<string, string | null> = {
  git: "git",
  rsync: "rsync",
  openresty: "openresty",
  certbot: "certbot",
  docker: null,
};

/**
 * Normalize a package-manager version to a comparable upstream semver:
 * strip an apt epoch (`1:…`) and debian/rpm revision (`…-1ubuntu7`) so
 * "1:2.43.0-1ubuntu7" → "2.43.0". Non-apt strings pass through mostly intact.
 */
export function normalizePkgVersion(raw: string): string {
  let v = raw.trim();
  const colon = v.lastIndexOf(":");
  if (colon !== -1) v = v.slice(colon + 1); // drop epoch
  const dash = v.indexOf("-");
  if (dash !== -1) v = v.slice(0, dash); // drop revision
  return v.trim();
}

async function tryExec(executor: CommandExecutor, cmd: string): Promise<string | null> {
  try {
    return await executor.exec(cmd);
  } catch {
    return null;
  }
}

/** Resolve the candidate (installable) version of `pkg`, or null. */
async function probeCandidate(
  executor: CommandExecutor,
  pm: EnvironmentProfile["packageManager"],
  pkg: string,
): Promise<string | null> {
  const q = `'${pkg.replace(/'/g, "'\\''")}'`; // sq — pkg is a fixed catalog name, quoted anyway
  if (pm === "apt") {
    // `apt-cache policy` reads the local cache (no root, no network) and prints
    // "  Candidate: <version>".
    const out = await tryExec(executor, `apt-cache policy ${q} 2>/dev/null`);
    return out?.match(/Candidate:\s*(\S+)/)?.[1]?.trim() ?? null;
  }
  if (pm === "dnf" || pm === "yum") {
    // Cached list; last "pkg.arch  version  repo" row carries the newest avail.
    const out = await tryExec(
      executor,
      `${pm} -q --cacheonly list available ${q} 2>/dev/null | tail -n1`,
    );
    return out?.trim().split(/\s+/)[1]?.trim() ?? null;
  }
  if (pm === "apk") {
    // `apk policy` prints one `  <version>:` line per available version (colon at
    // end of line), each followed by indented source lines (installed marker, repo
    // URLs); the last version line is newest.
    const out = await tryExec(executor, `apk policy ${q} 2>/dev/null`);
    const versions = [...(out?.matchAll(/^\s+([\w.+~-]+):\s*$/gm) ?? [])].map((m) => m[1]!);
    return versions.length ? versions[versions.length - 1]! : null;
  }
  return null;
}

/**
 * Enrich each installed, package-backed component with its available version +
 * an `updateAvailable` flag. Mutates the statuses in place. Never throws; probes
 * run in parallel (they're independent SSH round-trips).
 */
export async function enrichAvailableVersions(
  executor: CommandExecutor,
  profile: EnvironmentProfile,
  statuses: ComponentStatus[],
): Promise<void> {
  const targets = statuses.filter(
    (s) => s.installed && s.version && PACKAGE_NAMES[s.name],
  );
  await Promise.all(
    targets.map(async (s) => {
      try {
        const pkg = PACKAGE_NAMES[s.name]!;
        const candidate = await probeCandidate(executor, profile.packageManager, pkg);
        if (!candidate) return;
        const avail = normalizePkgVersion(candidate);
        const installed = normalizePkgVersion(s.version!);
        if (avail && compareSemver(avail, installed) > 0) {
          s.availableVersion = avail;
          s.updateAvailable = true;
        }
      } catch {
        /* best-effort: leave this component without an available version */
      }
    }),
  );
}
