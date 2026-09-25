/**
 * Shared repo-webhook reconciliation for push auto-deploy.
 *
 * A VCS webhook lives on a `(provider, owner, repo)` — so ALL projects in an org that
 * point at that repo must share ONE `webhookId`. This is the single home for the
 * register → deactivate-stale → fan-out-webhookId logic, used by BOTH the git
 * linker (`linkProjectRepo`) and the auto-deploy toggle (`setAutoDeploy`) so the
 * two can't drift. Scope is org + provider + repo (case-insensitive), NOT project group —
 * a repo can be shared by projects across groups.
 */

import { repos, type Project } from "@repo/db";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { VcsStrategyFactory } from "../vcs/vcs.factory";

function providerKey(provider?: string | null) {
  return provider || "github";
}

/** Projects in this org pointing at (provider, owner, repo), case-insensitive. */
export async function listOrgRepoProjects(
  organizationId: string,
  owner: string,
  repo: string,
  provider?: string | null,
) {
  const ownerKey = owner.toLowerCase();
  const repoKey = repo.toLowerCase();
  const expectedProvider = providerKey(provider);
  const projects = await repos.project.findByGitRepo(owner, repo);
  return projects.filter(
    (p) =>
      p.organizationId === organizationId &&
      providerKey(p.gitProvider) === expectedProvider &&
      p.gitOwner?.toLowerCase() === ownerKey &&
      p.gitRepo?.toLowerCase() === repoKey,
  );
}

/** An existing webhookId already shared across this org's projects on the repo. */
export async function findSharedWebhookId(
  organizationId: string,
  owner: string,
  repo: string,
  provider?: string | null,
) {
  const projects = await listOrgRepoProjects(organizationId, owner, repo, provider);
  return projects.find((p) => typeof p.webhookId === "number")?.webhookId ?? null;
}

/** Fan a webhookId onto every org project on (owner, repo) that lacks it. */
export async function syncSharedWebhookId(
  organizationId: string,
  owner: string,
  repo: string,
  webhookId: number,
  provider?: string | null,
) {
  const projects = await listOrgRepoProjects(organizationId, owner, repo, provider);
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
  owner: string,
  repo: string,
  webhookUrl?: string,
): Promise<number | null> {
  const existingHookId =
    project.webhookId ??
    (await findSharedWebhookId(project.organizationId, owner, repo, project.gitProvider));
  const result = await VcsStrategyFactory.getStrategy(project.gitProvider).registerWebhook(
    ctx,
    owner,
    repo,
    webhookUrl,
    { projectId: project.id },
  );
  if (!result?.id) return null;

  // A new hook superseded a stale one on the same repo — turn the old one off so
  // stale GitHub hooks don't pile up (the gap the old link path never closed).
  if (existingHookId && existingHookId !== result.id) {
    await VcsStrategyFactory.getStrategy(project.gitProvider)
      .updateWebhook(ctx, owner, repo, existingHookId, { active: false })
      .catch(() => undefined);
  }
  await syncSharedWebhookId(project.organizationId, owner, repo, result.id, project.gitProvider);
  return result.id;
}
