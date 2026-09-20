import { realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { AppError } from "@repo/core";

/** Set only by the owned worker's explicit, validated configuration. */
let sourceRoots: readonly string[] = [];
export function configureNativeSourceRoots(roots: readonly string[]) { sourceRoots = Object.freeze([...roots]); }

export function defaultNativeSourceRoot(): string {
  if (!sourceRoots[0]) throw new AppError("No sourceRoots are configured for this native installation", 403, "SOURCE_PATH_NOT_ALLOWED");
  return sourceRoots[0];
}

export async function assertNativeSourcePath(path: string): Promise<string> {
  const canonical = await realpath(path);
  if (process.env.OPENSHIP_NATIVE !== "true") return canonical;
  const allowed = sourceRoots.some(root => {
    const part = relative(root, canonical);
    return !isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\");
  });
  if (!allowed) throw new AppError("The source path is outside this installation's configured sourceRoots", 403, "SOURCE_PATH_NOT_ALLOWED");
  return canonical;
}
