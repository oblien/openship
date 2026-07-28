/**
 * Payload sizing for a cross-server migration — the shared denominator behind
 * both the wizard's "transfer plan" step (how many GB, per item) and the real
 * total-% progress bar. There is no cheap upfront size in Docker's API, so we
 * measure on the SOURCE: `du -sb` a volume's mountpoint / a bind path, and
 * `docker image inspect {{.Size}}` for a built image.
 *
 * Every probe is bounded by a timeout: a giant/slow `du` yields `null` (that
 * item is "unknown", `partial` flips true, the total becomes a lower bound)
 * rather than hanging the wizard or the move. `du -sb` reports APPARENT size,
 * which matches the bytes rsync actually streams — so it's the right
 * denominator for the bar.
 */

import type { CommandExecutor } from "@repo/adapters";
import { sq, statPath } from "./direct-transfer";

export interface MoveSet {
  /** Named volumes (bare names — resolved to mountpoints here). */
  volumeNames: string[];
  /** Movable bind-mount host paths. */
  bindPaths: string[];
  /** Built images that transfer as data — sized by `id` (reliable), labeled by
   *  `tag` in the result. */
  images: Array<{ id: string; tag: string }>;
  /** Arbitrary user-selected source paths (custom-path transfers). */
  customPaths?: string[];
}

export interface SizedItem {
  ref: string;
  kind: "volume" | "bind" | "image" | "path";
  /** Apparent size in bytes, or null when it couldn't be measured (timeout /
   *  missing / permission). */
  bytes: number | null;
  /** Source existence + type for a bind/custom PATH (a file bind is legal; a
   *  missing path warns up-front). Undefined for volume/image. */
  exists?: boolean;
  type?: "dir" | "file";
}

export interface MoveSetSize {
  perItem: SizedItem[];
  totalBytes: number;
  /** True when at least one item couldn't be measured → `totalBytes` is a lower
   *  bound (render it as "≥"). */
  partial: boolean;
}

const PROBE_TIMEOUT_MS = 20_000;
const INSPECT_TIMEOUT_MS = 10_000;
const SIZE_CONCURRENCY = 4;

/** Minimal bounded-concurrency map (no dep), order-preserving. */
export async function bounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export async function duBytes(exec: CommandExecutor, path: string): Promise<number | null> {
  // -s summarize, -b apparent bytes (matches rsync's transferred bytes).
  const out = await exec
    .exec(`du -sb ${sq(path)} 2>/dev/null | cut -f1`, { timeout: PROBE_TIMEOUT_MS })
    .catch(() => "");
  const n = Number(out.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function volumeBytes(exec: CommandExecutor, name: string): Promise<number | null> {
  const mp = (
    await exec
      .exec(`docker volume inspect ${sq(name)} --format '{{.Mountpoint}}' 2>/dev/null`, {
        timeout: INSPECT_TIMEOUT_MS,
      })
      .catch(() => "")
  ).trim();
  if (!mp) return null;
  return duBytes(exec, mp);
}

async function imageBytes(exec: CommandExecutor, ref: string): Promise<number | null> {
  const out = await exec
    .exec(`docker image inspect ${sq(ref)} --format '{{.Size}}' 2>/dev/null || echo`, {
      timeout: INSPECT_TIMEOUT_MS,
    })
    .catch(() => "");
  const n = Number(out.trim());
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Measure every item in the move-set on `exec` (the SOURCE server). Images are
 *  probed by `id` but reported under their `tag` for display. */
export async function sizeOfMoveSet(exec: CommandExecutor, set: MoveSet): Promise<MoveSetSize> {
  // `probe` is the ref used to measure; `ref` is the label shown to the user.
  const tasks: Array<{ ref: string; probe: string; kind: SizedItem["kind"] }> = [
    ...set.volumeNames.map((ref) => ({ ref, probe: ref, kind: "volume" as const })),
    ...set.bindPaths.map((ref) => ({ ref, probe: ref, kind: "bind" as const })),
    ...set.images.map((img) => ({ ref: img.tag, probe: img.id, kind: "image" as const })),
    ...(set.customPaths ?? []).map((ref) => ({ ref, probe: ref, kind: "path" as const })),
  ];
  const perItem = await bounded(tasks, SIZE_CONCURRENCY, async (t): Promise<SizedItem> => {
    const bytes =
      t.kind === "volume"
        ? await volumeBytes(exec, t.probe)
        : t.kind === "image"
          ? await imageBytes(exec, t.probe)
          : await duBytes(exec, t.probe); // bind + path
    // Up-front existence/type for a path the user can act on (bind/custom) so
    // the plan warns before the move — a missing path is the resolvable case.
    if (t.kind === "bind" || t.kind === "path") {
      const st = await statPath(exec, t.probe);
      return {
        ref: t.ref,
        kind: t.kind,
        bytes,
        exists: st !== "missing",
        type: st === "missing" ? undefined : st,
      };
    }
    return { ref: t.ref, kind: t.kind, bytes };
  });
  let totalBytes = 0;
  let partial = false;
  for (const it of perItem) {
    if (it.bytes == null) partial = true;
    else totalBytes += it.bytes;
  }
  return { perItem, totalBytes, partial };
}
