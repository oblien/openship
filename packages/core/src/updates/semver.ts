import { valid, validRange, satisfies } from "semver";

/**
 * Shared stable-release comparison and strict semver advisory matching.
 * Release ordering ignores suffixes; advisory ranges use standard semver rules.
 */

/** Parse "v1.2.3-rc.1" → [1, 2, 3] (leading v + prerelease/build stripped). */
export function parseSemver(v: string): [number, number, number] {
  const core = (v ?? "").trim().replace(/^v/i, "").split(/[-+]/)[0] ?? "";
  const parts = core.split(".").map((n) => parseInt(n, 10) || 0);
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/** -1 if a<b, 0 if equal, 1 if a>b. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! > pb[i]!) return 1;
    if (pa[i]! < pb[i]!) return -1;
  }
  return 0;
}

/**
 * Standard semver ranges, including disjoint release branches with `||`.
 * Unknown/invalid versions and empty ranges never count as a match.
 */
export function satisfiesRange(version: string, range: string): boolean {
  return !!version && !!range?.trim() && !!valid(version) && !!validRange(range) && satisfies(version, range);
}
