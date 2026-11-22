/**
 * Provider boundary for shared deployment and project workflows.
 *
 * Adapters own protocol, connection selection and authorization. Callers carry
 * the original execution context and may not cache credentials by repository
 * path alone. Existing GitHub App/PAT/CLI resolvers remain the authority.
 *
 * GitHub-specific public routes and OAuth/webhook verification remain
 * compatibility entry points. Adding another provider must supply its own
 * connection and verified event ingress, then reuse these operations and the
 * existing deployment pipeline. This registry never falls back across providers.
 */
import { DEFAULT_GIT_PROVIDER, GITHUB_PROVIDER, GITLAB_PROVIDER, type RegisteredGitProvider, AppError, gitProviderForGrant, hasProjectRepository, type ProjectGitSource } from "@repo/core";
export { hasProjectRepository, type ProjectGitSource } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import type { DatabaseTransaction } from "@repo/db";
import { gitlabProvider } from "./providers/gitlab";
import { githubProvider } from "./providers/github";
import type { GitProvider, GitReadOptions, GitRepositoryRef } from "./types";

// Adding public provider metadata requires registering its engine adapter here.
const adapters = {
  [GITHUB_PROVIDER.id]: githubProvider,
  [GITLAB_PROVIDER.id]: gitlabProvider,
} satisfies Record<RegisteredGitProvider["id"], GitProvider>;
const providers: readonly GitProvider[] = Object.freeze(Object.values(adapters));
const cloudConnections = providers.flatMap(provider => {
  const connection = provider.connections.cloudSession;
  return connection ? [{ provider, connection }] : [];
});

export async function invalidateCloudGitCaches(userId: string, organizationIds: readonly string[]) {
  await Promise.all(cloudConnections.map(({ connection }) => connection.invalidateCache(userId, organizationIds)));
}

export async function revokeCloudGitGrants(tx: DatabaseTransaction, organizationId: string) {
  const { createResourceGrantRepo } = await import("@repo/db/repos");
  const grants = createResourceGrantRepo(tx);
  for (const { provider, connection } of cloudConnections) {
    const retained = await connection.retainedNamespaces(tx, organizationId);
    if (retained !== null) await grants.deleteForGitProvider(organizationId, provider, retained);
  }
}

export function getGitProvider(id: string): GitProvider {
  const provider = providers.find(provider => provider.id === id);
  if (provider) return provider;
  throw new AppError(`Git provider "${id}" is not supported`, 400, "GIT_PROVIDER_UNSUPPORTED");
}

export function gitGrantProvider(resourceType: string) {
  const definition = gitProviderForGrant(resourceType);
  return definition && getGitProvider(definition.id);
}

export { gitGrantTarget } from "@repo/core";

export function requireGitCapability<T>(capability: T | undefined, name: string): T {
  if (!capability)
    throw new AppError(
      `This Git provider does not support ${name}`,
      400,
      "GIT_CAPABILITY_UNAVAILABLE",
    );
  return capability;
}

export function projectGitProvider(project: ProjectGitSource): GitProvider {
  return getGitProvider(project.gitProvider ?? DEFAULT_GIT_PROVIDER);
}

export function gitRepository(
  ctx: ExecutionContext,
  ref: GitRepositoryRef,
  options?: GitReadOptions,
) {
  return getGitProvider(ref.provider).repository(ctx, ref, options);
}

export function projectRepositoryRef(project: ProjectGitSource): GitRepositoryRef {
  if (!project.gitOwner || !project.gitRepo)
    throw new AppError("The project no longer has a repository", 409, "ACTIONS_PROJECT_CHANGED");
  return {
    provider: project.gitProvider ?? DEFAULT_GIT_PROVIDER,
    namespace: project.gitOwner,
    name: project.gitRepo,
  };
}

export function projectRepository(
  ctx: ExecutionContext,
  project: ProjectGitSource,
  options?: GitReadOptions,
) {
  return gitRepository(ctx, projectRepositoryRef(project), options);
}

export function repositoryWebhooks(ctx: ExecutionContext, ref: GitRepositoryRef) {
  const hooks = gitRepository(ctx, ref).webhooks;
  if (!hooks)
    throw new AppError(
      "This Git provider does not support repository webhooks",
      400,
      "GIT_WEBHOOKS_UNAVAILABLE",
    );
  return hooks;
}

export async function assertProjectRepositoryAccess(
  ctx: ExecutionContext,
  project: ProjectGitSource,
) {
  if (!hasProjectRepository(project)) return;
  await projectRepository(ctx, project).assertAccess();
}
