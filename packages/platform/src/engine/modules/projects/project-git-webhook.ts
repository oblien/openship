/**
 * Shared repo-webhook reconciliation for push auto-deploy.
 *
 * A repository webhook lives on a `(owner, repo)` — so ALL projects in an org that
 * point at that repo must share ONE `webhookId`. This is the single home for the
 * register → deactivate-stale → fan-out-webhookId logic, used by BOTH the git
 * linker (`linkProjectRepo`) and the auto-deploy toggle (`setAutoDeploy`) so the
 * two can't drift. Scope is org + repo (case-insensitive), NOT project group —
 * a repo can be shared by projects across groups.
 */

import { matchesProjectRepository } from "@repo/core";
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { repos, type Project } from "@repo/db";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import type { GitRepositoryRef } from "../git/types";
import { repositoryWebhooks } from "../git/provider";

/** An existing webhookId already shared across this org's projects on the repo. */
export async function findSharedWebhookId(organizationId: string, ref: GitRepositoryRef) {
  const projects = await repos.project.findByGitRepo(ref, [organizationId]);
  return projects.find((p) => p.webhookId != null)?.webhookId ?? null;
}

/** Fan a webhookId onto every org project on (owner, repo) that lacks it. */
export async function syncSharedWebhookId(
  organizationId: string,
  ref: GitRepositoryRef,
  webhookId: string,
) {
  const projects = await repos.project.findByGitRepo(ref, [organizationId]);
  await Promise.all(
    projects
      .filter((p) => p.webhookId !== webhookId)
      .map((p) => repos.project.update(p.id, { webhookId })),
  );
}

/**
 * Register (or reuse) the repo's webhook, deactivate a superseded hook, and fan
 * the resulting webhookId across the org's same-repo projects. Returns the hookId,
 * or null when registration didn't yield one (e.g. no repo-admin access).
 * `webhookUrl` omitted → the shared same-origin callback (registerWebhook default).
 */
export async function ensureSharedWebhook(
  ctx: RequestContext,
  project: Project,
  ref: GitRepositoryRef,
  webhookUrl?: string,
): Promise<string | null> {
  const hooks = repositoryWebhooks(ctx, ref);
  const existingHookId =
    (matchesProjectRepository(project, ref) ? project.webhookId : null) ??
    (await findSharedWebhookId(project.organizationId, ref));
  const result = await hooks.register({ url: webhookUrl, projectId: project.id });
  if (!result.id) return null;
  const hookId = result.id;

  // A new hook superseded a stale one on the same repo — turn the old one off so
  // stale hooks don't pile up (the gap the old link path never closed).
  if (existingHookId && existingHookId !== hookId) {
    await hooks.setActive(String(existingHookId), false).catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "platform/engine/modules/projects/project-git-webhook"); return undefined; });
  }
  await syncSharedWebhookId(project.organizationId, ref, hookId);
  return hookId;
}
