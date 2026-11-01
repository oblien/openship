import type { BaseImageReceipt } from "@repo/core";

const digestPattern = /^sha256:[a-f0-9]{64}$/;
const literalImageRef = (ref: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(ref) &&
  !/^sha256:/.test(ref) &&
  ref.split("@").length <= 2;

/** Freeze supported FROM instructions before building, so a receipt describes
 * bytes actually selected by the build, rather than a later registry scan. */
export async function pinDockerfileBaseImages(
  dockerfile: string,
  resolveDigest: (ref: string) => Promise<string | undefined>,
  signal?: AbortSignal,
): Promise<{ dockerfile: string; baseImages?: BaseImageReceipt[] }> {
  const unknown = { dockerfile };
  if (
    dockerfile.length > 1_048_576 ||
    dockerfile.includes("\0") ||
    /\\\r?\n|<<|^\s*#\s*escape\s*=/im.test(dockerfile)
  )
    return unknown;
  const frontend = dockerfile.match(/^\s*#\s*syntax\s*=\s*(\S+)/im)?.[1];
  if (
    frontend &&
    !/^(?:docker\.io\/)?docker\/dockerfile(?::[\w.-]+)?(?:@sha256:[a-f0-9]{64})?$/.test(frontend)
  )
    return unknown;
  const stages = new Set<string>();
  const replacements: Array<{ start: number; end: number; ref: string }> = [];
  let fromCount = 0;
  for (const match of dockerfile.matchAll(/^[ \t]*FROM[ \t]+([^\r\n]*)/gim)) {
    const instruction = match[1]!.match(/^(\S+)(?:[ \t]+AS[ \t]+([\w.-]+))?[ \t]*$/i);
    // Dynamic ARGs, continuations and platform selection remain explicitly unknown.
    if (!instruction || /[$\\]/.test(instruction[1]!) || instruction[1]!.startsWith("--"))
      return unknown;
    fromCount++;
    const ref = instruction[1]!;
    if (ref.toLowerCase() !== "scratch" && !stages.has(ref.toLowerCase())) {
      if (!literalImageRef(ref)) return unknown;
      const start = match.index! + match[0].length - match[1]!.length;
      replacements.push({ start, end: start + ref.length, ref });
    }
    if (instruction[2]) stages.add(instruction[2].toLowerCase());
  }
  if (!fromCount || replacements.length > 16) return unknown;
  // Generated PHP recipes copy Composer from its own image. Pin that material
  // too, while preserving COPY references to earlier stages.
  for (const match of dockerfile.matchAll(/^[ \t]*COPY[^\r\n]*?[ \t]--from=([^\s]+)/gim)) {
    const ref = match[1]!;
    if (/^\d+$/.test(ref) || stages.has(ref.toLowerCase())) continue;
    if (!literalImageRef(ref)) return unknown;
    const start = match.index! + match[0].lastIndexOf("--from=") + "--from=".length;
    replacements.push({ start, end: start + ref.length, ref });
  }
  if (replacements.length > 16) return unknown;
  for (const match of dockerfile.matchAll(/--mount=[^\r\n]*?\bfrom=([^,\s]+)/gi)) {
    if (!stages.has(match[1]!.toLowerCase())) return unknown;
  }
  const selected = new Map<string, string>();
  try {
    for (const { ref } of replacements) {
      signal?.throwIfAborted();
      if (selected.has(ref)) continue;
      const pinned = ref.split("@")[1];
      const digest = pinned ?? (await resolveDigest(ref));
      signal?.throwIfAborted();
      if (!digest || !digestPattern.test(digest)) return unknown;
      selected.set(ref, digest);
    }
  } catch {
    // diagnostics-ignore: optional receipt resolution falls back to an explicitly unknown baseline; the original build still owns pull failures.
    signal?.throwIfAborted();
    return unknown;
  }
  let pinned = dockerfile;
  for (const { start, end, ref } of replacements.sort((a, b) => b.start - a.start)) {
    const digest = selected.get(ref)!;
    pinned = pinned.slice(0, start) + `${ref.split("@")[0]}@${digest}` + pinned.slice(end);
  }
  return {
    dockerfile: pinned,
    baseImages: [...selected].map(([ref, digest]) => ({ ref, digest })),
  };
}
