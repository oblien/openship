import { repos, type Project } from "@repo/db";
import { compareCommitSha } from "@repo/core";
import { type RequestContext } from "../../lib/request-context";
import { compareCommits } from "../github/github.service";
import { classifyChangedFiles, routeServicesByChanges } from "../github/webhook-changed-files";

/**
 * Smart per-service routing for a MANUAL multi-service redeploy.
 *
 * Traces which services' roots changed between the active deployment's commit
 * and the new HEAD and rebuilds ONLY those, so the version atomically captures
 * the affected services. This is the dashboard "Redeploy" button's path.
 *
 * ORCHESTRATOR, not a classifier: it composes `compareCommits` (the git diff)
 * with the SHARED leaf classifiers in github/webhook-changed-files
 * (`classifyChangedFiles` / `routeServicesByChanges`) — the exact same matching
 * the webhook uses, so per-service targeting is identical with no duplicated
 * logic. It deliberately imports NOTHING from build.service, staying a leaf.
 *
 * Falls back to a full rebuild (`forceAll`) for single-app / same-commit /
 * config-only / can't-diff cases so a manual redeploy never silently no-ops, and
 * the `skip` mode (routable services exist but none matched) also collapses to
 * `forceAll` — a human clicked Redeploy and must get SOMETHING (the webhook, by
 * contrast, treats `skip` as a no-op since a no-op push shouldn't deploy).
 *
 * Inert unless `smartRoute` is set and the caller hasn't already decided routing
 * (`forceAll` / `serviceIds`) and this isn't an atomic reuse/rollback.
 */
export async function resolveSmartRoute(
  ctx: RequestContext,
  project: Project,
  opts: {
    smartRoute?: boolean;
    forceAll?: boolean;
    serviceIds?: string[];
    /** True on the atomic reuseSnapshot rollback path — never smart-route there. */
    isReuse?: boolean;
    commitSha?: string;
    commitShaBefore?: string;
  },
): Promise<{ forceAll: boolean; serviceIds?: string[]; changedPaths?: string[] }> {
  let resolvedForceAll = opts.forceAll ?? false;
  let resolvedServiceIds = opts.serviceIds;
  let resolvedChangedPaths: string[] | undefined;

  if (opts.smartRoute && !opts.forceAll && !opts.serviceIds?.length && !opts.isReuse) {
    const enabled = (await repos.service.listByProject(project.id).catch(() => [])).filter(
      (s) => s.enabled,
    );
    const routable = enabled.filter((s) => s.kind === "compose" || s.kind === "monorepo");
    if (
      routable.length === 0 ||
      !opts.commitSha ||
      !opts.commitShaBefore ||
      // Same identity rule the drift banner uses: an abbreviated sha on one side
      // is not a second commit to diff against.
      compareCommitSha(opts.commitSha, opts.commitShaBefore) === "same" ||
      !project.gitOwner ||
      !project.gitRepo
    ) {
      // single-app, same commit, config-only, or no diffable repo → rebuild all
      resolvedForceAll = true;
    } else {
      const compare = await compareCommits(
        ctx,
        project.gitOwner,
        project.gitRepo,
        opts.commitShaBefore,
        opts.commitSha,
      ).catch(() => null);
      if (!compare) {
        resolvedForceAll = true; // can't determine the diff → safe full rebuild
      } else {
        const files = new Set(compare.files);
        resolvedChangedPaths = Array.from(files);
        const cls = classifyChangedFiles(files, {
          isMonorepo: project.framework === "monorepo" || routable.length > 0,
          monorepoSharedPaths: project.monorepoSharedPaths,
        });
        if (cls.forceAll) {
          resolvedForceAll = true;
        } else {
          const routed = routeServicesByChanges(routable, files);
          if (routed.mode === "services") resolvedServiceIds = routed.serviceIds;
          else resolvedForceAll = true; // "all"/"skip" → rebuild all (manual intent)
        }
      }
    }
  }

  return {
    forceAll: resolvedForceAll,
    serviceIds: resolvedServiceIds,
    changedPaths: resolvedChangedPaths,
  };
}
