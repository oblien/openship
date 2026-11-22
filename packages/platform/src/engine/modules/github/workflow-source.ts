import { AppError, ValidationError, isFullCommitSha, type ActionActorIdentity } from "@repo/core";
import type { ExecutionContext } from "../../../context";
import type { GitWorkflowSource } from "../git/capabilities";

/** Existing Actions source protocol and github.com worker restriction. */
export function githubWorkflowSource(
  ctx: ExecutionContext,
  owner: string,
  repo: string,
): Omit<GitWorkflowSource, "controllers" | "paths"> {
  const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  return {
    async assertRequiredChecks() {
      const { repos } = await import("@repo/db");
      if (!(await repos.gitInstallation.findByOrgAndOwner(ctx.organizationId, owner)))
        throw new AppError(
          "Connect a GitHub App for this repository to run required checks and receive its push events",
          409,
          "ACTIONS_GITHUB_APP_REQUIRED",
        );
    },
    async inspectChecks(controller) {
      return (await import("../actions/repository-checks")).githubActionRepositoryChecks(ctx, {
        owner,
        repo,
        controller,
        gitProvider: "github",
      });
    },
    async syncCheck(run, job) {
      return (await import("../actions/github-checks")).syncActionCheck(run, job);
    },
    async assertExecution() {
      const { resolveGitHubApiBaseUrl } = await import("./github-source.service");
      const api = await resolveGitHubApiBaseUrl(ctx.organizationId, owner);
      // Never give an Enterprise credential to the pinned github.com worker.
      if (api && api.replace(/\/$/, "") !== "https://api.github.com")
        throw new AppError(
          "Actions currently supports github.com repositories. GitHub Enterprise runners are not available yet.",
          422,
          "ACTIONS_GITHUB_HOST_UNSUPPORTED",
        );
    },
    async resolveRef(ref, preference = "branch") {
      const { githubFetch } = await import("./github.auth");
      if (isFullCommitSha(ref)) return ref;
      if (preference === "branch" && ref.startsWith("refs/")) return ref;
      const kinds = ref.startsWith("refs/heads/")
        ? ["heads"]
        : ref.startsWith("refs/tags/")
          ? ["tags"]
          : preference === "tag"
            ? ["tags", "heads"]
            : ["heads", "tags"];
      for (const kind of kinds) {
        const name = ref.replace(new RegExp(`^refs/${kind}/`), "");
        const refs = await githubFetch<Array<{ ref: string }>>({
          ctx,
          owner,
          repo,
          url: `${base}/git/matching-refs/${kind}/${encodeURIComponent(name)}`,
        });
        const resolved = refs.find((item) => item.ref === `refs/${kind}/${name}`)?.ref;
        if (resolved) return resolved;
      }
      throw new ValidationError(`Branch or tag ${ref} was not found`);
    },
    async updateFile(input) {
      const { githubFetch } = await import("./github.auth");
      const result = await githubFetch<{ content: { sha: string }; commit: { sha: string } }>({
        ctx,
        owner,
        repo,
        url: `${base}/contents/${input.path.split("/").map(encodeURIComponent).join("/")}`,
        method: "PUT",
        params: {
          branch: input.branch,
          sha: input.sha,
          content: Buffer.from(input.content).toString("base64"),
          message: input.message,
        },
      });
      return { sha: result.content.sha, commit: result.commit.sha };
    },
    async actor(login) {
      const { GitHubActionsApi } = await import("../actions/github-api");
      return githubActionActor(await new GitHubActionsApi(ctx, owner, repo).user(login));
    },
    async canWrite(actor) {
      const { GitHubActionsApi } = await import("../actions/github-api");
      if (actor.provider !== "github") return false;
      const permission = await new GitHubActionsApi(ctx, owner, repo).collaborator(actor.login);
      return (
        String(permission.user.id) === actor.id &&
        ["admin", "write", "maintain"].includes(permission.permission)
      );
    },
    async token(permissions) {
      const { getInstallationToken } = await import("./github.auth");
      return getInstallationToken(ctx, owner, undefined, {
        repositories: [repo],
        permissions,
        noCache: true,
      });
    },
  };
}

export function githubActionActor(
  value: { id?: string | number; login: string } | null | undefined,
): ActionActorIdentity | null {
  return value &&
    (typeof value.id !== "number" || Number.isSafeInteger(value.id)) &&
    /^[1-9]\d*$/.test(String(value.id)) &&
    value.login
    ? { provider: "github", id: String(value.id), login: value.login }
    : null;
}
