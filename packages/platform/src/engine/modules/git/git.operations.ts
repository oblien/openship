import { AppError } from "@repo/core";
import type { GitDependencies } from "../../../git";
import { getGitProvider, gitRepository, requireGitCapability } from "./provider";
import { paginateRepoList } from "@repo/contracts/git-repo-list";
import { resolveProjectInfo, projectInfoToScanResponse } from "../deployments/prepare.service";

export const gitDependencies: GitDependencies = {
  async listRepos(ctx, input) {
    const provider = getGitProvider(input.provider);
    const rows = await provider.listRepositories(ctx, input.owner);
    if (rows === null)
      throw new AppError(`Not connected to ${provider.name}`, 400, "GIT_CONNECTION_REQUIRED");
    return paginateRepoList(rows, input);
  },
  async getRepo(ctx, input) {
    const repo = gitRepository(
      ctx,
      { provider: input.provider, namespace: input.owner, name: input.repo },
      input,
    );
    await repo.assertAccess("read");
    return repo.info({ withBranches: input.branches });
  },
  async listBranches(ctx, input) {
    const repo = gitRepository(
      ctx,
      { provider: input.provider, namespace: input.owner, name: input.repo },
      input,
    );
    await repo.assertAccess("read");
    const { branches, ...pagination } = await repo.branches(input.page);
    return { data: branches, pagination };
  },
  async listFiles(ctx, input) {
    return gitRepository(
      ctx,
      { provider: input.provider, namespace: input.owner, name: input.repo },
      input,
    ).browseFiles(input.path, input.branch);
  },
  async listTree(ctx, input) {
    return gitRepository(
      ctx,
      { provider: input.provider, namespace: input.owner, name: input.repo },
      input,
    ).browseTree(input.branch);
  },
  async getFile(ctx, input) {
    const repo = gitRepository(
      ctx,
      { provider: input.provider, namespace: input.owner, name: input.repo },
      input,
    );
    await repo.assertAccess("read");
    const branch = input.branch ?? (await repo.info()).default_branch;
    return { ...(await repo.readFile(input.file, branch)), download_url: null };
  },
  async detectStack(ctx, input) {
    const repo = gitRepository(
      ctx,
      { provider: input.provider, namespace: input.owner, name: input.repo },
      input,
    );
    await repo.assertAccess("read");
    return projectInfoToScanResponse(await resolveProjectInfo({ source: "git", ...input, ctx }));
  },
  async publishChange(ctx, input) {
    const repo = gitRepository(ctx, {
      provider: input.provider,
      namespace: input.owner,
      name: input.repo,
    });
    await repo.assertAccess("write");
    const { provider: _, owner, repo: name, ...change } = input;
    return requireGitCapability(repo.changes, "source updates").publish(change);
  },
};
