import { formatVolumeMount, parseVolumeMount, parseVolumeSpec } from "@repo/core";

/** Configuration change only. Docker creates the new volume during normal deployment. */
export function emptyVolumePlan(volumes: readonly string[], selected: string) {
  const parsed = parseVolumeSpec(selected);
  if (
    parsed.kind !== "named" ||
    parsed.readOnly ||
    !parsed.target?.startsWith("/") ||
    volumes.filter((value) => parseVolumeSpec(value).target === parsed.target).length !== 1 ||
    !volumes.includes(selected)
  )
    return null;
  const source = `openship-fresh-${crypto.randomUUID()}`;
  const mount = formatVolumeMount({ ...parseVolumeMount(selected), source });
  if (mount.length > 500) return null;
  return {
    previous: parsed.source,
    source,
    target: parsed.target,
    volumes: volumes.map((value) => (value === selected ? mount : value)),
  };
}
export type EmptyVolumePlan = NonNullable<ReturnType<typeof emptyVolumePlan>>;
