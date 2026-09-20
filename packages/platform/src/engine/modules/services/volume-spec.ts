/**
 * Parse a Docker Compose short-syntax volume string into its parts so we can
 * classify it (named volume vs host bind vs anonymous) and know its in-container
 * target — the join point for measuring on-disk size (see getServiceVolumeSizes).
 *
 * Short syntax: `[SOURCE:]TARGET[:MODE]` where MODE is a comma list of access +
 * option flags (ro, rw, z, Z, cached, delegated, consistent, nocopy, …). A bare
 * `TARGET` (no colon) is an anonymous volume. SOURCE may itself be a host path
 * (starts with / ./ ../ or ~) → a bind mount; otherwise a named volume.
 *
 * We stay on the Linux host convention (the deploy target): no Windows
 * `C:\path` drive-letter handling, since containers here always run on Linux.
 */

// Single source of truth for named-vs-bind classification — the same predicate
// the runtime uses when it namespaces volumes at deploy time.
import { isHostPathSource } from "@repo/adapters";
export { isHostPathSource };

const MODE_FLAG =
  /^(ro|rw|z|Z|cached|delegated|consistent|nocopy|private|rprivate|shared|rshared|slave|rslave)$/;

/** True when a mode-list segment ("ro", "ro,z", "rw,cached") — i.e. the trailing
 *  `:MODE` group rather than another path segment. */
function isModeSegment(seg: string): boolean {
  const parts = seg.split(",");
  return parts.length > 0 && parts.every((p) => MODE_FLAG.test(p));
}

export type VolumeKind = "named" | "bind" | "anonymous";

export interface ParsedVolume {
  /** The original string, verbatim (what the UI shows). */
  raw: string;
  /** Left token: a volume name or a host path. Empty for an anonymous volume. */
  source: string;
  /** In-container mount path — the key we match against `docker inspect .Mounts`
   *  Destination to find the real on-host Source. Null only if unparseable. */
  target: string | null;
  kind: VolumeKind;
  readOnly: boolean;
}

export function parseVolumeSpec(raw: string): ParsedVolume {
  const spec = raw.trim();
  const parts = spec.split(":");

  // Bare target → anonymous volume (Docker allocates an unnamed volume).
  if (parts.length === 1) {
    return { raw, source: "", target: parts[0] || null, kind: "anonymous", readOnly: false };
  }

  // Trailing `:MODE` group (only when there's a source+target in front of it).
  let readOnly = false;
  let segs = parts;
  const last = parts[parts.length - 1]!;
  if (parts.length >= 3 && isModeSegment(last)) {
    readOnly = last.split(",").includes("ro");
    segs = parts.slice(0, -1);
  }

  const target = segs[segs.length - 1] || null;
  // A source can itself contain ':' only in exotic cases; rejoin everything
  // before the target so an odd path isn't silently truncated.
  const source = segs.slice(0, -1).join(":");

  if (!source) {
    return { raw, source: "", target, kind: "anonymous", readOnly };
  }
  return {
    raw,
    source,
    target,
    kind: isHostPathSource(source) ? "bind" : "named",
    readOnly,
  };
}
