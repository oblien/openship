/**
 * Shared repo-webhook reconciliation for push auto-deploy.
 *
 * A GitHub webhook lives on a `(owner, repo)` — so ALL projects in an org that
 * point at that repo must share ONE `webhookId`. This is the single home for the
 * register → deactivate-stale → fan-out-webhookId logic, used by BOTH the git
 * linker (`linkProjectRepo`) and the auto-deploy toggle (`setAutoDeploy`) so the
 * two can't drift. Scope is org + repo (case-insensitive), NOT project group —
 * a repo can be shared by projects across groups.
 */

import { repos, type Project } from "@repo/db";
import type { RequestContext } from "../../lib/request-context";
import { registerWebhook, updateWebhook } from "../github/github.service";

/** Projects in this org pointing at (owner, repo), case-insensitive. */
export async function listOrgRepoProjects(organizationId: string, owner: string, repo: string) {
  const ownerKey = owner.toLowerCase();
  const repoKey = repo.toLowerCase();
  const projects = await repos.project.findByGitRepo(owner, repo);
  return projects.filter(
    (p) =>
      p.organizationId === organizationId &&
      p.gitOwner?.toLowerCase() === ownerKey &&
      p.gitRepo?.toLowerCase() === repoKey,
  );
}

/** An existing webhookId already shared across this org's projects on the repo. */
export async function findSharedWebhookId(organizationId: string, owner: string, repo: string) {
  const projects = await listOrgRepoProjects(organizationId, owner, repo);
  return projects.find((p) => typeof p.webhookId === "number")?.webhookId ?? null;
}

/** Fan a webhookId onto every org project on (owner, repo) that lacks it. */
export async function syncSharedWebhookId(
  organizationId: string,
  owner: string,
  repo: string,
  webhookId: number,
) {
  const projects = await listOrgRepoProjects(organizationId, owner, repo);
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
    project.webhookId ?? (await findSharedWebhookId(project.organizationId, owner, repo));
  const result = await registerWebhook(ctx, owner, repo, webhookUrl, { projectId: project.id });
  if (!result.hookId) return null;

  // A new hook superseded a stale one on the same repo — turn the old one off so
  // stale GitHub hooks don't pile up (the gap the old link path never closed).
  if (existingHookId && existingHookId !== result.hookId) {
    await updateWebhook(ctx, owner, repo, existingHookId, { active: false }).catch(() => undefined);
  }
  await syncSharedWebhookId(project.organizationId, owner, repo, result.hookId);
  return result.hookId;
}
