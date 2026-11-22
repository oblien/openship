/**
 * Extract the changed-files set + force-all signal from a GitHub push payload.
 *
 * Used by the webhook handler to drive smart per-service deploys —
 * services whose `rootDirectory` doesn't appear in the changed set are
 * marked `skipped` rather than rebuilt.
 *
 * "forceAll" overrides smart routing and rebuilds every service. We
 * derive it from four signals:
 *
 *   1. `payload.forced === true` (a `git push --force`). The commit
 *      list is unreliable in that case; the caller should still call
 *      `compareCommits(before, after)` if it cares about the file set.
 *   2. `head_commit.message` contains `[force]`, `[force-deploy]`, or
 *      `[redeploy-all]` (case-insensitive).
 *   3. A repository-wide build input changed (Dockerfile, compose,
 *      manifests, lockfiles, workspace config) — these affect every service.
 *   4. For monorepos (`framework === "monorepo"` or compose-style
 *      projects) a `packages/**` file changed — v1 assumes any shared
 *      package may affect every sub-app and forces all.
 *
 * The caller passes a `compareCommits` function (optional) so we can
 * unit-test without hitting the network. When the push event truncates
 * commits[] at 20, we call it; otherwise we union commits[].(added |
 * modified | removed).
 */

import { classifyChangedFiles, FORCE_DEPLOY_MESSAGE } from "../git/changed-files";
import type { GitHubPushPayload } from "@repo/contracts";

import type { ChangedFilesResult } from "../git/changed-files";
export type { ChangedFilesResult } from "../git/changed-files";

export interface CompareCommitsFn {
  (
    owner: string,
    repo: string,
    base: string,
    head: string,
  ): Promise<{ files: string[]; truncated?: boolean } | null>;
}

interface ExtractOptions {
  /**
   * Optional hook used to fan out to GitHub's compare API when the push
   * truncated commits[]. Called with (owner, repo, base, head).
   */
  compareCommits?: CompareCommitsFn;
  /**
   * Project type — currently only `framework: "monorepo"` triggers
   * shared-package detection.
   */
  isMonorepo?: boolean;
  /**
   * Optional monorepo shared paths. When provided AND non-empty, any
   * file under one of these path prefixes triggers forceAll. Null or
   * empty = the shared-paths check is skipped entirely (smart per-service
   * routing only). There is no built-in default: in pnpm-workspace
   * layouts `packages/web` is itself a deployable service, so a
   * one-size-fits-all default of `["packages/", "libs/"]` would
   * force-rebuild everything on every push.
   */
  monorepoSharedPaths?: string[] | null;
}

export async function extractChangedFiles(
  payload: GitHubPushPayload,
  opts: ExtractOptions = {},
): Promise<ChangedFilesResult> {
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const before = payload.before;
  const after = payload.after;

  // 1. Force-push: the commit list is unreliable — the caller will call
  //    compareCommits separately if it wants the file list. We mark
  //    forceAll so smart routing is bypassed regardless.
  if (payload.forced) {
    return { files: new Set<string>(), forceAll: true, reason: "force-push" };
  }

  // 2. Build the changed-files set.
  let files: Set<string>;
  let truncated = false;

  const commits = payload.commits ?? [];
  // GitHub clamps payload.commits at 20 today; treat >= 20 as
  // "potentially truncated" so a future bump (or an off-by-one in the
  // docs) doesn't silently strand commits.
  if (commits.length >= 20 && opts.compareCommits && owner && repo && before && after) {
    // commits[] is clamped to 20 per push — fall back to compare API
    // so smart routing sees the full set.
    const compare = await opts.compareCommits(owner, repo, before, after);
    if (compare) {
      files = new Set(compare.files);
      truncated = compare.truncated === true;
    } else {
      // compare failed → degrade to the truncated commits[] union and
      // signal upstream that the deploy may be missing some changes.
      files = unionCommitFiles(commits);
      truncated = true;
    }
  } else {
    files = unionCommitFiles(commits);
  }

  // 3. Commit-message force token.
  const headMessage = payload.head_commit?.message ?? "";
  if (FORCE_DEPLOY_MESSAGE.test(headMessage)) {
    return { files, forceAll: true, reason: "commit-token", truncated };
  }

  // 4 + 5. File-set-based force triggers (root-config / monorepo shared-package).
  //   Shared with the manual smart-redeploy path via classifyChangedFiles.
  const cls = classifyChangedFiles(files, {
    isMonorepo: opts.isMonorepo,
    monorepoSharedPaths: opts.monorepoSharedPaths,
  });
  return { files, forceAll: cls.forceAll, reason: cls.reason, truncated };
}

function unionCommitFiles(commits: GitHubPushPayload["commits"] = []): Set<string> {
  const out = new Set<string>();
  for (const c of commits ?? []) {
    for (const f of c.added ?? []) out.add(f);
    for (const f of c.modified ?? []) out.add(f);
    for (const f of c.removed ?? []) out.add(f);
  }
  return out;
}

export { classifyChangedFiles, routeServicesByChanges, serviceMatchesChanges, projectMatchesChanges } from "../git/changed-files";
