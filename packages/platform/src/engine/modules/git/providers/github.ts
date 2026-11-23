import { Value } from "@sinclair/typebox/value";
import { GitHubCollectionSchemas } from "@repo/contracts";
import { AppError, GITHUB_PROVIDER } from "@repo/core";
import type { GitProvider } from "../types";

// Share lazy module initialization across concurrent reads. Only the transport
// module is retained; request contexts and credentials are never cached here.
let service: Promise<typeof import("../../github/github.service")> | undefined;
const githubService = () => (service ??= import("../../github/github.service"));

function webhookId(value: string): number {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new AppError("Invalid GitHub webhook ID", 400, "GIT_WEBHOOK_ID_INVALID");
  return Number(value);
}

/** GitHub wire formats and App/PAT/CLI authentication stay on this side of the boundary. */
export const githubProvider: GitProvider = {
  id: GITHUB_PROVIDER.id,
  name: GITHUB_PROVIDER.name,
  async currentUser(ctx) {
    const status = await (await import("../../github/github.auth")).getUserStatus(ctx.userId, ctx);
    return status.connected
      ? (await import("../../github/workflow-source")).githubActionActor({
          id: status.id,
          login: status.login,
        })
      : null;
  },
  preferTargetClone: true,
  async openCloneRelay(options) {
    return (await import("../../../lib/git-forwarding/index")).openDeployRelay(options);
  },
  grantTypes: GITHUB_PROVIDER.grantTypes,
  async grantResources(ctx, kind, owner) {
    const { createGitHubSource } = await import("../../github/sources/index");
    const source = await createGitHubSource(ctx);
    if (kind === "namespace")
      return (await source.getHome()).accounts.map((account) => ({
        id: account.login,
        label: account.login,
        meta: { type: account.type },
      }));
    const rows = owner ? await source.listReposForOwner(owner) : (await source.getHome()).repos;
    return (rows ?? []).map((repo) => ({
      id: repo.full_name,
      label: repo.full_name,
      meta: { visibility: repo.private ? "private" : "public" },
    }));
  },
  errors: {
    async status(error) {
      return (await import("../../github/provider-capabilities")).githubErrors.status(error);
    },
    async isMissingFile(error) {
      return (await import("../../github/provider-capabilities")).githubErrors.isMissingFile(error);
    },
    async isTransient(error) {
      return (await import("../../github/provider-capabilities")).githubErrors.isTransient(error);
    },
    async isCredentialFailure(error) {
      return (await import("../../github/provider-capabilities")).githubErrors.isCredentialFailure(
        error,
      );
    },
    async credentialError() {
      return (await import("../../github/provider-capabilities")).githubErrors.credentialError();
    },
  },
  access: {
    async canUse(...args) {
      return (await import("../../github/github-access")).canUseGitHubRepo(...args);
    },
    async source(...args) {
      return (await import("../../github/github-access")).resolveSourceAccess(...args);
    },
    async checkSource(...args) {
      return (await import("../../github/github-access")).checkSourceTier(...args);
    },
  },
  connections: {
    cloudSession: {
      async invalidateCache(userId, organizationIds) {
        const { invalidateUserGitHubCache, invalidateOrgGitHubCache } = await import("../../github/github.auth");
        await Promise.all([invalidateUserGitHubCache(userId), ...organizationIds.map(invalidateOrgGitHubCache)]);
      },
      async retainedNamespaces(tx, organizationId) {
        const { configuredGitHubAuthMode } = await import("../../github/github.auth");
        if (configuredGitHubAuthMode()) return null;
        const { createGitInstallationRepo } = await import("@repo/db/repos");
        const installations = await createGitInstallationRepo(tx).listByOrganization(organizationId);
        // A source-bound App supplies its own credentials. Source-less rows can be old Cloud snapshots.
        return installations.filter(row => row.sourceId !== null).map(row => row.owner);
      },
    },
    async domainWebhookUrl(hostname, scheme) {
      return (await import("../../../lib/public-url")).domainWebhookUrl(hostname, scheme, GITHUB_PROVIDER.id);
    },
    async strategy(...args) {
      return (await githubService()).resolveWebhookStrategy(...args);
    },
    async strategies(...args) {
      return (await githubService()).getAvailableStrategies(...args);
    },
    async installation(...args) {
      return (await import("../../github/github.auth")).getInstallationIdByOrg(...args);
    },
    async installUrl(ctx) {
      return (await import("../../github/github.auth")).resolveInstallUrl(ctx);
    },
    async managesInstallations(organizationId) {
      const { env } = await import("../../../config/env");
      return (
        env.CLOUD_MODE ||
        (await githubService()).getWebhookStrategy() === "app" ||
        (await import("../../github/github-source.service")).hasActiveGitHubSource(organizationId)
      );
    },
  },
  async cloneUrl(organizationId, ref, installationId) {
    const { resolveGitHubWebBaseUrl } = await import("../../github/github-source.service");
    const base = await resolveGitHubWebBaseUrl(
      organizationId,
      ref.namespace,
      installationId ?? undefined,
    );
    return base ? `${base.replace(/\/+$/, "")}/${ref.namespace}/${ref.name}.git` : null;
  },
  preflight: {
    async isPublicRepository(url, namespace, name) {
      const { githubPreflight } = await import("./github-preflight");
      return githubPreflight.isPublicRepository(url, namespace, name);
    },
    async checks(input) {
      const { githubPreflight } = await import("./github-preflight");
      return githubPreflight.checks(input);
    },
  },
  async listRepositories(ctx, namespace) {
    const { createGitHubSource } = await import("../../github/sources/index");
    const { filterAllowedRepos } = await import("../../github/github-access");
    const { githubRepositoryKey } = await import("../../github/sources/mappers");
    const repos = await (await createGitHubSource(ctx)).listReposForOwner(namespace);
    return repos === null ? null : filterAllowedRepos(ctx, repos, githubRepositoryKey);
  },
  async resolveCloneCredentials(options) {
    const { resolveBuildGitToken } = await import("../../github/clone-auth");
    const { env } = await import("../../../config/env");
    return resolveBuildGitToken({
      ...options,
      allowApiHostFallback: !env.CLOUD_MODE && options.allowApiHostFallback,
    });
  },
  repository(ctx, ref, options = {}) {
    const { namespace: owner, name: repo } = ref;
    if (!Value.Check(GitHubCollectionSchemas.getRepo.input, { owner, repo }))
      throw new AppError("Invalid GitHub repository identity", 400, "GIT_REPOSITORY_INVALID");
    const revision = async (ref: string): Promise<string> => {
      const { githubFetch } = await import("../../github/github.auth");
      return (
        await githubFetch<{ sha: string }>({
          ctx,
          owner,
          repo,
          serverId: options.serverId,
          url: `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`,
        })
      ).sha;
    };
    return {
      ref,
      async browseFiles(path, branch) {
        return (await import("../../github/github-application.service")).listFiles(ctx, {
          owner,
          repo,
          path,
          branch,
          ...options,
        });
      },
      async browseTree(branch) {
        return (await import("../../github/github-application.service")).listTree(ctx, {
          owner,
          repo,
          branch,
          ...options,
        });
      },
      async readFile(path, branch) {
        return (await import("../../github/github-application.service")).getRawFile(ctx, {
          owner,
          repo,
          file: path,
          branch,
          ...options,
        });
      },
      async fileUrl(path, branch) {
        const { resolveGitHubWebBaseUrl } = await import("../../github/github-source.service");
        const base =
          (await resolveGitHubWebBaseUrl(ctx.organizationId, owner)) ?? "https://github.com";
        return `${base.replace(/\/$/, "")}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`;
      },
      workflows: {
        async eventActor(event) {
          return (await import("../../github/workflow-source")).githubActionActor(
            event.sender as { id?: string | number; login: string } | undefined,
          );
        },
        controllers: ["openship", "github"],
        paths: [".github/workflows", ".openship/workflows"],
        async inspectChecks(controller) {
          return (await import("../../github/workflow-source"))
            .githubWorkflowSource(ctx, owner, repo)
            .inspectChecks(controller);
        },
        async syncCheck(run, job) {
          return (await import("../../github/workflow-source"))
            .githubWorkflowSource(ctx, owner, repo)
            .syncCheck(run, job);
        },
        async assertRequiredChecks() {
          return (await import("../../github/workflow-source"))
            .githubWorkflowSource(ctx, owner, repo)
            .assertRequiredChecks();
        },
        async assertExecution() {
          return (await import("../../github/workflow-source"))
            .githubWorkflowSource(ctx, owner, repo)
            .assertExecution();
        },
        async resolveRef(...args) {
          return (await import("../../github/workflow-source"))
            .githubWorkflowSource(ctx, owner, repo)
            .resolveRef(...args);
        },
        async updateFile(input) {
          return (await import("../../github/workflow-source"))
            .githubWorkflowSource(ctx, owner, repo)
            .updateFile(input);
        },
        async actor(login) {
          return (await import("../../github/workflow-source"))
            .githubWorkflowSource(ctx, owner, repo)
            .actor(login);
        },
        async canWrite(actor) {
          return (await import("../../github/workflow-source"))
            .githubWorkflowSource(ctx, owner, repo)
            .canWrite(actor);
        },
        async token(permissions) {
          return (await import("../../github/workflow-source"))
            .githubWorkflowSource(ctx, owner, repo)
            .token(permissions);
        },
      },
      changes: {
        async access(paths) {
          return (await import("../../github/repository-change-access")).getRepositoryChangeAccess(
            ctx,
            owner,
            repo,
            paths,
          );
        },
        async publish(input) {
          const { publishChange } = await import("../../github/repository-changes");
          const { REPOSITORY_PR_PERMISSIONS } =
            await import("../../github/repository-change-access");
          return publishChange(
            ctx,
            { ...input, owner, repo },
            input.pullRequest ? { installationPermissions: REPOSITORY_PR_PERMISSIONS } : undefined,
          );
        },
      },
      pullRequests: {
        async list(options) {
          return (await import("../../github/provider-capabilities"))
            .githubPullRequests(ctx, owner, repo)
            .list(options);
        },
        async get(number) {
          return (await import("../../github/provider-capabilities"))
            .githubPullRequests(ctx, owner, repo)
            .get(number);
        },
        async comments(number, page) {
          return (await import("../../github/provider-capabilities"))
            .githubPullRequests(ctx, owner, repo)
            .comments(number, page);
        },
        async comment(number, body, id) {
          return (await import("../../github/provider-capabilities"))
            .githubPullRequests(ctx, owner, repo)
            .comment(number, body, id);
        },
      },
      info: async (opts) =>
        (await githubService()).getRepository(ctx, owner, repo, { ...options, ...opts }),
      async branch(name) {
        const branch = await (await githubService()).getBranch(ctx, owner, repo, name);
        return branch
          ? { name: branch.name, sha: branch.commit.sha, protected: branch.protected }
          : null;
      },
      async branches(page) {
        const result = await (
          await githubService()
        ).listBranches(ctx, owner, repo, {
          ...options,
          ...(page === undefined ? {} : { page }),
        });
        return {
          ...result,
          branches: result.branches.map((branch) => ({
            name: branch.name,
            sha: branch.commit.sha,
            protected: branch.protected,
          })),
        };
      },
      commit: async (ref) => (await githubService()).getCommitByRef(ctx, owner, repo, ref, options),
      latestCommit: async (branch) =>
        (await githubService()).getLatestCommit(ctx, owner, repo, branch, options),
      head: (branch) => revision(`refs/heads/${branch}`),
      revision,
      commits: async (branch, limit) =>
        (await githubService()).getRecentCommits(ctx, owner, repo, branch, limit),
      compare: async (base, head) =>
        (await githubService()).compareCommits(ctx, owner, repo, base, head),
      async files(path, branch, signal) {
        const github = await githubService();
        signal?.throwIfAborted();
        const files = await github.listFiles(ctx, owner, repo, {
          ...options,
          branch,
          ...(path ? { path } : {}),
          ...(signal ? { signal } : {}),
        });
        return Array.isArray(files)
          ? files.map((file) => ({
              name: file.name,
              type: file.type === "dir" ? ("dir" as const) : ("file" as const),
            }))
          : [];
      },
      async tree(branch, opts) {
        const github = await githubService();
        opts?.signal?.throwIfAborted();
        return github.listRepositoryTree(ctx, owner, repo, {
          ...options,
          branch,
          ...opts,
        });
      },
      async file(path, branch, signal) {
        const github = await githubService();
        signal?.throwIfAborted();
        return github.getFileContent(ctx, owner, repo, path, {
          ...options,
          branch,
          ...(signal ? { signal } : {}),
        });
      },
      async assertAccess(operation) {
        const { assertGitHubRepoAccess } = await import("../../github/github-access");
        return assertGitHubRepoAccess(ctx, { owner, repo }, operation);
      },
      webhooks: {
        async register(options) {
          const result = await (
            await githubService()
          ).registerWebhook(ctx, owner, repo, options.url, {
            projectId: options.projectId,
          });
          return {
            id: result.hookId === null ? null : String(result.hookId),
            events: result.events,
          };
        },
        async setActive(id, active) {
          await (await githubService()).updateWebhook(ctx, owner, repo, webhookId(id), { active });
        },
        async delete(id) {
          await (await githubService()).deleteWebhook(ctx, owner, repo, webhookId(id));
        },
      },
      checks: {
        async sync(id, update, options) {
          const { syncGitHubCheck } = await import("../../github/check-runs");
          return syncGitHubCheck(ctx, owner, repo, id, update, options);
        },
      },
    };
  },
};
