/** Linux container mounts, shared by the editor and the deployment engine. */
export interface VolumeMount {
  source: string;
  target: string;
  options: string[];
}

export type VolumeKind = "named" | "bind" | "anonymous";

export interface ParsedVolume {
  raw: string;
  source: string;
  target: string | null;
  kind: VolumeKind;
  readOnly: boolean;
}

const MODE_FLAG =
  /^(ro|rw|z|Z|cached|delegated|consistent|nocopy|private|rprivate|shared|rshared|slave|rslave)$/;

export function isHostPathSource(source: string): boolean {
  return (
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith("~")
  );
}

/** Keep every mount option when editing the source or destination independently. */
export function parseVolumeMount(raw: string): VolumeMount {
  const parts = raw.trim().split(":");
  const last = parts[parts.length - 1]!;
  const modes = last.split(",");
  const options = parts.length > 1 && modes.every((mode) => MODE_FLAG.test(mode)) ? modes : [];
  if (options.length) parts.pop();
  const target = parts.pop() ?? "";
  return { source: parts.join(":"), target, options };
}

/** These binds need the repository to be prepared before creating a container. */
export function hasRelativeVolumeMounts(volumes?: readonly string[] | null): boolean {
  return Boolean(volumes?.some(raw => {
    const { source } = parseVolumeMount(raw);
    return source === "." || source === ".." || source.startsWith("./") || source.startsWith("../");
  }));
}

export function formatVolumeMount(mount: VolumeMount): string {
  const source = mount.source.trim();
  const target = mount.target.trim();
  const path = source ? `${source}:${target}` : target;
  return mount.options.length ? `${path}:${mount.options.join(",")}` : path;
}

/** The existing measurement shape; editor-only options do not leak into API output. */
export function parseVolumeSpec(raw: string): ParsedVolume {
  const { source, target, options } = parseVolumeMount(raw);
  return {
    raw,
    source,
    target: target || null,
    kind: !source ? "anonymous" : isHostPathSource(source) ? "bind" : "named",
    readOnly: options.includes("ro"),
  };
}
