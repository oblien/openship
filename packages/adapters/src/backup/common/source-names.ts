import { createHash } from "node:crypto";

/** Keep archive names readable without letting two paths overwrite one another. */
export function sourceArchiveName(source: string): string {
  const label =
    source
      .replace(/^\/+/, "")
      .replace(/[^a-zA-Z0-9._-]/g, "_")
      .slice(0, 64) || "data";
  return `${label}-${createHash("sha256").update(source).digest("hex").slice(0, 16)}`;
}
