/**
 * Locate the prebuilt Openship release dist that the migration wizard streams
 * to the operator's remote server. Thin wrapper over the shared release-dist
 * resolver (apps/api/src/lib/release-dist.ts) — this file only pins the
 * openship-specific spec (repo, asset name, repo-local dev path) and preserves
 * the typed OpenshipReleaseDistMissingError the wizard controller catches.
 */

import type { ReleaseSource } from "@repo/core";
import {
  ReleaseDistMissingError,
  apiRootPath,
  readApiVersion,
  resolveReleaseDist,
  resolveReleaseDistOrNull,
  type ReleaseDistSpec,
} from "../../../lib/release-resolver";

const OPENSHIP_SOURCE: ReleaseSource = {
  mode: "github",
  repo: "oblien/openship",
  assetTemplate: "openship-{tag}-linux-amd64.tar.gz",
};

function openshipDistSpec(): ReleaseDistSpec {
  return {
    name: "openship",
    version: readApiVersion(),
    source: OPENSHIP_SOURCE,
    envOverride: "OPENSHIP_RELEASE_DIST_PATH",
    repoLocalPath: apiRootPath("release-dist"),
  };
}

export class OpenshipReleaseDistMissingError extends Error {
  readonly code = "OPENSHIP_RELEASE_DIST_MISSING" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpenshipReleaseDistMissingError";
  }
}

/** Resolve (download on miss) the Openship release dist directory. */
export async function resolveOpenshipDistDir(): Promise<string> {
  try {
    return (await resolveReleaseDist(openshipDistSpec())).dir;
  } catch (err) {
    if (err instanceof ReleaseDistMissingError) {
      throw new OpenshipReleaseDistMissingError(
        `${err.message} Build it with \`bun run --cwd apps/api build-release\` or set OPENSHIP_RELEASE_DIST_PATH.`,
        { cause: (err as { cause?: unknown }).cause },
      );
    }
    throw err;
  }
}

/** Non-throwing, no-download variant for preflight. */
export function resolveOpenshipDistDirOrNull(): string | null {
  return resolveReleaseDistOrNull(openshipDistSpec());
}
