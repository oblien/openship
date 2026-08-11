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

import { compareSemver, type SystemPackageManager } from "@repo/core";
import type { CommandExecutor } from "../types";
import type { EnvironmentProfile } from "./environment";
import { envOps, opScript } from "./environment-ops";
import { tryExec } from "./probe-exec";
import type { ComponentStatus } from "./types";

/** Component name → OS package name. null = not a tracked package (e.g. docker
 *  is installed via get.docker.com, not a repo package we can query). */
const PACKAGE_NAMES: Record<string, string | null> = {
  git: "git",
  rsync: "rsync",
  // The edge is an IMAGE, not a repo package — its "newer version available" comes
  // from the registry (see the update scanner's imageDigest), never from apt.
  edge: null,
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

/**
 * How to read a candidate version out of each manager's own output.
 *
 * The COMMAND comes from `envOps`; only the parse stays here, because it is a fact
 * about the tool's output format rather than about the host. Total on purpose: a
 * manager added to the union has to state its parse or state that it has none.
 */
const READ_CANDIDATE: Readonly<Record<SystemPackageManager, ((out: string) => string | null) | null>> =
  {
    // `apt-cache policy` prints "  Candidate: <version>".
    apt: (out) => out.match(/Candidate:\s*(\S+)/)?.[1]?.trim() ?? null,
    // Cached list; the last "pkg.arch  version  repo" row carries the newest avail.
    dnf: (out) => out.trim().split(/\s+/)[1]?.trim() ?? null,
    yum: (out) => out.trim().split(/\s+/)[1]?.trim() ?? null,
    // `apk policy` prints one `  <version>:` line per available version (colon at end
    // of line), each followed by indented source lines (installed marker, repo URLs);
    // the last version line is newest.
    apk: (out) => {
      const versions = [...out.matchAll(/^\s+([\w.+~-]+):\s*$/gm)].map((m) => m[1]!);
      return versions.length ? versions[versions.length - 1]! : null;
    },
    // Both refuse the probe itself, so there is no output to read. Stated rather than
    // omitted — `null` here is paired with a refusal, not with a missing branch.
    brew: null,
    none: null,
  };

/**
 * Resolve the candidate (installable) version of `pkg`, or null.
 *
 * A refused probe is swallowed deliberately: this whole surface decorates a health
 * check with an "update available" badge. A host we cannot query shows no badge,
 * which is the same thing a stale index shows. Nothing is provisioned from here.
 */
async function probeCandidate(
  executor: CommandExecutor,
  profile: EnvironmentProfile,
  pkg: string,
): Promise<string | null> {
  const read = READ_CANDIDATE[profile.packageManager];
  const probe = envOps(profile).pkgAvailableVersion(pkg);
  if (!read || !probe.supported) return null;
  const out = await tryExec(executor, opScript(probe.value));
  return out ? read(out) : null;
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
        const candidate = await probeCandidate(executor, profile, pkg);
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
