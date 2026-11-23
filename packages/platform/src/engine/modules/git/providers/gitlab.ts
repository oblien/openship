import { AppError, GITLAB_PROVIDER, gitProviderSettingsHref, gitRepositoryUrl, parseGitRepositoryUrl } from "@repo/core";
import type { GitRepositorySummary } from "@repo/contracts";
import { gitlabAccess, gitlabRepository } from "../../gitlab/repository";
import {
  allPages,
  gitlabRequest,
  gitlabCredentials,
  isGitLabStatus,
  isGitLabCredentialError,
  projectConnection,
  projectPath,
  segment,
  summary,
  type GitLabProject,
} from "../../gitlab/client";
import type { GitCloneOptions, BuildGitCredential } from "../clone-types";
import type { GitProvider } from "../types";
import type { GitProviderConnections } from "../capabilities";

const id = GITLAB_PROVIDER.id;
async function publicCallback() {
  const { isLocalUrl, sharedWebhookUrl } = await import("../../../lib/public-url");
  return !isLocalUrl(sharedWebhookUrl(id));
}
const strategy: GitProviderConnections["strategy"] = async (project) =>
  project?.webhookDomain ? "domain" : (await publicCallback()) ? "repo" : "none";
const connectionError = () =>
  new AppError(
    "Connect a GitLab account or access token with permission to read this repository.",
    403,
    "GITLAB_CONNECTION_REQUIRED",
  );

const listRepositories: GitProvider["listRepositories"] = async (ctx, namespace) => {
  if (!ctx.organizationId) return null;
  const tokens = await gitlabCredentials(ctx.organizationId).catch((error: unknown) => {
    if (isGitLabCredentialError(error))
      throw new AppError(error.message, error.statusCode, "GIT_CONNECTION_REQUIRED");
    throw error;
  });
  if (!tokens.length) return null;
  const projects = new Map<number, GitRepositorySummary>();
  let accepted = false;
  for (const { token, source } of tokens) {
    try {
      const rows = await allPages((page) =>
        gitlabRequest<GitLabProject[]>("projects", token, {
          membership: "true",
          page,
          per_page: "100",
          order_by: "id",
          sort: "asc",
        }),
      );
      accepted = true;
      for (const row of rows) {
        if (namespace && row.namespace.full_path.toLowerCase() !== namespace.toLowerCase())
          continue;
        if (source === "token" || !projects.has(row.id)) projects.set(row.id, summary(row, source));
      }
    } catch (error) {
      if (!isGitLabStatus(error, 401, 403)) throw error;
    }
  }
  if (!accepted) return null;
  return gitlabAccess.filterAllowedRepos(ctx, [...projects.values()], (r) => ({
    owner: r.owner,
    repo: r.name,
  }));
};

function privateGitLabCloneRequiresDocker() {
  return new AppError(
    "Use Docker for private GitLab repository deployments. OpenShip checks out the repository on the controller and transfers the source to the build server.",
    403,
    "GITLAB_CONNECTION_REQUIRED",
  );
}

async function resolveGitLabClone({
  ctx,
  owner,
  repo,
  repoUrl,
  buildStrategy,
  allowApiHostFallback,
}: Pick<
  GitCloneOptions,
  "ctx" | "owner" | "repo" | "repoUrl" | "buildStrategy" | "allowApiHostFallback"
>): Promise<BuildGitCredential> {
  if (!owner || !repo) return {};
  const ref = { provider: id, namespace: owner, name: repo };
  const expected = gitRepositoryUrl(id, owner, repo)!;
  if (!ctx.organizationId || (repoUrl && repoUrl !== expected && repoUrl !== expected.slice(0, -4)))
    throw new AppError(
      "GitLab clone origin does not match the project.",
      400,
      "GIT_CLONE_ORIGIN_INVALID",
    );
  if (!(await gitlabAccess.canUse(ctx, { owner, repo }, "read")))
    throw new AppError("GitLab repository access denied", 403);
  const allowHostCli = buildStrategy === "local" || allowApiHostFallback === true;
  let connection;
  try {
    connection = await projectConnection(ctx.organizationId, ref, allowHostCli);
  } catch (error) {
    if (!allowHostCli && isGitLabStatus(error, 401, 403, 404))
      throw privateGitLabCloneRequiresDocker();
    throw error;
  }
  const { project, token } = connection;
  if (project.visibility === "public") return { anonymous: true };
  if (!token) throw connectionError();
  if (!allowHostCli) throw privateGitLabCloneRequiresDocker();
  return { token, tokenRepositories: [ref.name], apiHostFallback: true };
}

export const gitlabProvider: GitProvider = {
  id,
  name: GITLAB_PROVIDER.name,
  grantTypes: GITLAB_PROVIDER.grantTypes,
  preferTargetClone: false,
  access: gitlabAccess,
  listRepositories,
  repository: gitlabRepository,
  async grantResources(ctx, kind, namespace) {
    const rows = (await listRepositories(ctx, namespace)) ?? [];
    if (kind === "namespace")
      return [...new Set(rows.map((r) => r.owner))].map((owner) => ({
        id: owner,
        label: owner,
        meta: { type: "group" },
      }));
    return rows.map((r) => ({
      id: r.full_name,
      label: r.full_name,
      meta: { visibility: r.visibility },
    }));
  },
  errors: {
    status: (e) => (e instanceof AppError ? e.statusCode : undefined),
    isMissingFile: (e) => isGitLabStatus(e, 404),
    isTransient: (e) =>
      e instanceof TypeError ||
      (e instanceof AppError && (e.statusCode === 429 || e.statusCode >= 500)),
    isCredentialFailure: isGitLabCredentialError,
    credentialError: connectionError,
  },
  connections: {
    strategy,
    domainWebhookUrl: async (hostname, scheme) =>
      (await import("../../../lib/public-url")).domainWebhookUrl(hostname, scheme, id),
    async strategies(ctx, project) {
      return {
        current: await strategy(project, ctx.organizationId),
        available: (await publicCallback()) ? ["domain", "repo"] : ["domain"],
      };
    },
    async installation() {
      return null;
    },
    async managesInstallations() {
      return false;
    },
    async installUrl() {
      return { url: gitProviderSettingsHref(id) };
    },
  },
  async cloneUrl(_org, ref) {
    projectPath(ref);
    return gitRepositoryUrl(id, ref.namespace, ref.name)!;
  },
  resolveCloneCredentials: resolveGitLabClone,
  preflight: {
    async isPublicRepository(url, owner, repo) {
      const parsed = url && parseGitRepositoryUrl(url);
      if (url && (!parsed || parsed.provider !== id)) return false;
      const namespace = owner ?? (parsed && parsed.owner),
        name = repo ?? (parsed && parsed.repo);
      if (!namespace || !name) return false;
      try {
        const row = await gitlabRequest<GitLabProject>(
          "projects/" + segment(projectPath({ provider: id, namespace, name })),
        );
        return row.visibility === "public";
      } catch {
        /* diagnostics-ignore: an anonymous lookup cannot establish public visibility. */ return false;
      }
    },
    async checks(input) {
      if (!input.ctx || !input.namespace || !input.name || !input.remoteCredential) return [];
      const base = { id: "gitlab-repository", label: "GitLab repository access" };
      try {
        await resolveGitLabClone({
          ctx: input.ctx,
          owner: input.namespace,
          repo: input.name,
          buildStrategy: "server",
          allowApiHostFallback: input.canStageSourceOnApiHost ?? input.dockerClonesOnTarget,
        });
        return [{ ...base, status: "pass" }];
      } catch (error) {
        /* diagnostics-ignore: preflight exposes the remediation, never a credential or upstream body. */ return [
          {
            ...base,
            status: "fail",
            code: "GITLAB_CONNECTION_REQUIRED",
            message:
              error instanceof AppError && error.code === "GITLAB_CONNECTION_REQUIRED"
                ? error.message
                : connectionError().message,
          },
        ];
      }
    },
  },
};
