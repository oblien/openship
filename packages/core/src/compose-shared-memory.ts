import { ValidationError } from "./errors";

export const MAX_COMPOSE_SHM_BYTES = 2 ** 40;

/** Docker shared memory stays private to this container; no host IPC namespace. */
export function parseComposeShmSize(value: unknown): number | undefined {
  if (value == null) return undefined;
  let bytes: number;
  if (typeof value === "number") bytes = value;
  else if (typeof value === "string") {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/i);
    if (!match) throw new ValidationError("shm_size must be bytes or a size such as 2g");
    const exponent = { "": 0, k: 1, m: 2, g: 3, t: 4 }[match[2]!.toLowerCase()]!;
    bytes = Number(match[1]) * 1024 ** exponent;
  } else throw new ValidationError("shm_size must be bytes or a size such as 2g");
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > MAX_COMPOSE_SHM_BYTES)
    throw new ValidationError("Shared memory must be between 1 byte and 1 TiB");
  return bytes;
}

/** Same error contract as the shared GPU reader, for imports and SDK/CLI sync. */
export function readComposeShmConfig(raw: unknown, interpolate = (value: string) => value) {
  try {
    const shmSize = parseComposeShmSize(typeof raw === "string" ? interpolate(raw) : raw);
    return { config: shmSize === undefined ? {} : { shmSize }, issues: [] };
  } catch (error) {
    // diagnostics-ignore: the importer returns this validation failure as a blocking issue.
    if (!(error instanceof ValidationError)) throw error;
    return { config: {}, issues: [{ field: "shm_size", reason: error.message, blocking: true }] };
  }
}
