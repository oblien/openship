import { valid } from "semver";
import { validateImageReference } from "./project-source";

/** Only official Node/Bun images have a runtime version we can select by tag. */
export function managedRuntimeImage(ref: string) {
  if (validateImageReference(ref)) return null;
  const match =
    /^(?:(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\/)?((?:library\/)?node|oven\/bun)(?::([^@]+))?(?:@sha256:[a-f0-9]{64})?$/.exec(
      ref,
    );
  if (!match) return null;
  const runtime = match[1] === "oven/bun" ? "bun" : "node";
  const tag = match[2] ?? "latest";
  // Preserve the distribution; never turn a canary/prerelease into a stable tag.
  const parts =
    /^(\d+(?:\.\d+){0,2}|latest|lts|current)((?:-(?:alpine(?:\d+(?:\.\d+)*)?|slim|bookworm|bullseye|trixie|debian|distroless))*)$/.exec(
      tag,
    );
  if (!parts) return null;
  return {
    runtime,
    repository: runtime === "bun" ? "oven/bun" : "node",
    version: valid(parts[1]) ?? null,
    major: /^\d/.test(parts[1]) ? Number(parts[1].split(".")[0]) : null,
    variant: parts[2],
  } as const;
}
