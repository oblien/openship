import { createHmac } from "node:crypto";
import { isMaskedValue } from "@repo/core";
import { env } from "../config/env";

/** Compare stored literal args across a write response and deployment history
 * without returning their values or an offline-guessable unkeyed hash. Scope to
 * the project, service name and key so writing guesses in another project or
 * service cannot be used as a fingerprint oracle. */
export function fingerprintBuildArgs(
  projectId: string,
  serviceName: string,
  args: Record<string, string | null>,
  templateKeys?: string[],
): Record<string, string> {
  const fingerprints: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(args)) {
    // Null inherits a value at build time. Templates also depend on that build's
    // environment; fingerprinting the expression would falsely attest a value.
    if (
      typeof value !== "string" ||
      isMaskedValue(value) ||
      (Array.isArray(templateKeys) ? templateKeys.includes(key) : value.includes("$"))
    ) {
      continue;
    }
    fingerprints[key] = `hmac-sha256:${createHmac("sha256", env.BETTER_AUTH_SECRET)
      .update(JSON.stringify(["openship-build-arg-v1", projectId, serviceName, key, value]))
      .digest("hex")}`;
  }
  return fingerprints;
}
