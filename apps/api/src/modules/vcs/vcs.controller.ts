import type { Context } from "hono";
import { audit, auditContextFrom } from "../../lib/audit";
import { getRequestContext } from "../../lib/request-context";
import { AppError } from "@repo/core";
import { VcsStrategyFactory } from "./vcs.factory";
import { paginateRepoList, type RepoListParams } from "../github/repo-list";
import { filterAllowedRepos, filterTreeEntries } from "../github/github-access";
import { resolveProjectInfo, projectInfoToScanResponse } from "../deployments/prepare.service";

/** Map a MappedRepository to the owner/repo key the access filter needs. */
function repoKey(r: { full_name?: string; owner?: string; name?: string }) {
  const [owner, repo] = (r.full_name ?? "").split("/");
  return { owner: owner || r.owner || "", repo: repo || r.name || "" };
}

function validateProvider(provider: string) {
  if (provider !== "github" && provider !== "gitlab" && provider !== "self-hosted") {
    throw new AppError(`Unknown VCS provider: ${provider}`, 404, "NOT_FOUND");
  }
}

function param(c: Context, name: string): string {
  const val = c.req.param(name);
  if (!val) throw new Error(`Missing route param: ${name}`);
  return val;
}

function parseRepoListParams(c: Context): RepoListParams {
  const num = (raw?: string) => {
    const n = Number(raw);
    return raw && Number.isFinite(n) ? n : undefined;
  };
  const visibility = c.req.query("visibility");
  const sort = c.req.query("sort");
  return {
    page: num(c.req.query("page")),
    perPage: num(c.req.query("perPage")),
    search: c.req.query("search") || undefined,
    visibility:
      visibility === "public" || visibility === "private" || visibility === "all"
        ? visibility
        : undefined,
    sort: sort === "name" || sort === "stars" || sort === "updated" ? sort : undefined,
  };
}

export const listRepos = (provider: string) => async (c: Context) => {
  validateProvider(provider);
  const ctx = getRequestContext(c);
  const owner = c.req.query("owner");
  const strategy = VcsStrategyFactory.getStrategy(provider);
  const repos = await strategy.listRepositories(ctx, owner);
  const allowed = await filterAllowedRepos(ctx, repos as any, repoKey);
  return c.json(paginateRepoList(allowed as any, parseRepoListParams(c)));
}

export const listOrgRepos = (provider: string) => async (c: Context) => {
  validateProvider(provider);
  const ctx = getRequestContext(c);
  const org = param(c, "org");
  const strategy = VcsStrategyFactory.getStrategy(provider);
  const repos = await strategy.listRepositories(ctx, org);
  const allowed = await filterAllowedRepos(ctx, repos as any, repoKey);
  return c.json(paginateRepoList(allowed as any, parseRepoListParams(c)));
}

export const getRepo = (provider: string) => async (c: Context) => {
  validateProvider(provider);
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const strategy = VcsStrategyFactory.getStrategy(provider);
  const withBranches = c.req.query("branches") === "true";
  const data = await strategy.getRepository(ctx, owner, repo, { withBranches });
  return c.json({ data });
}

export const listBranches = (provider: string) => async (c: Context) => {
  validateProvider(provider);
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const strategy = VcsStrategyFactory.getStrategy(provider);
  const data = await strategy.getBranches(ctx, owner, repo);
  return c.json({ data });
}

export const getCloneToken = (provider: string) => async (c: Context) => {
  validateProvider(provider);
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const strategy = VcsStrategyFactory.getStrategy(provider);
  const result = await strategy.getCloneToken(ctx, owner, repo);
  return c.json(result);
}

export const detectStack = (provider: string) => async (c: Context) => {
  validateProvider(provider);
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const branch = c.req.query("branch")?.trim();
  const composePath = c.req.query("composePath")?.trim();

  // The prepare.service resolveProjectInfo currently only supports github as a remote source.
  const info = await resolveProjectInfo({
    source: "github", provider: provider,
    owner,
    repo,
    ctx,
    ...(branch ? { branch } : {}),
    ...(composePath ? { composePath } : {}),
  });

  return c.json({ data: projectInfoToScanResponse(info) });
}

export const listFiles = (provider: string) => async (c: Context) => {
  validateProvider(provider);
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const branch = c.req.query("branch");
  const path = c.get("sourcePath") as string | undefined;

  const strategy = VcsStrategyFactory.getStrategy(provider);
  const data = await strategy.listFiles(ctx, owner, repo, {
    branch: branch ?? undefined,
    path: path || undefined,
  });

  const readPaths = (c.get("sourceReadPaths") as string[] | undefined) ?? [];

  const isDir = Array.isArray(data);
  const entries: any[] = isDir ? (data as any) : [data];
  const visible = filterTreeEntries(entries, readPaths, (entry) => ({
    path: entry.path,
    isDirectory: isDir ? entry.type === "dir" : false,
  }));

  if (!isDir) {
    if (visible.length === 0) {
      return c.json({ error: "Not found", code: "NOT_FOUND" }, 404);
    }
    return c.json({ data: visible[0] });
  }
  return c.json({ data: visible });
}

export const listTree = (provider: string) => async (c: Context) => {
  validateProvider(provider);
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const branch = c.req.query("branch")?.trim();

  const strategy = VcsStrategyFactory.getStrategy(provider);
  // Github listRepositoryTree is wrapped by strategy.getTree
  const data = await strategy.getTree(ctx, owner, repo, branch ?? "");

  const readPaths = (c.get("sourceReadPaths") as string[] | undefined) ?? [];
  const entries = data.tree;
  const visible = filterTreeEntries(entries, readPaths, (entry) => ({
    path: entry.path || "",
    isDirectory: entry.type === "tree",
  }));
  return c.json({ data: visible });
}

export const getFile = (provider: string) => async (c: Context) => {
  validateProvider(provider);
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const branch = c.req.query("branch");
  const file = c.get("sourcePath") as string | undefined;

  if (!file) {
    return c.json(
      { error: "Query parameter `file` is required", code: "FILE_PARAM_REQUIRED" },
      400,
    );
  }

  const strategy = VcsStrategyFactory.getStrategy(provider);
  const data = await strategy.getFileContent(ctx, owner, repo, file, {
    branch: branch ?? undefined,
    json: file.endsWith(".json"),
  });
  return c.json({ data });
}

export const listWebhooks = (provider: string) => async (c: Context) => {
  validateProvider(provider);
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const strategy = VcsStrategyFactory.getStrategy(provider);
  const data = await strategy.listWebhooks(ctx, owner, repo);
  return c.json({ data });
}

export const registerWebhook = (provider: string) => async (c: Context) => {
  validateProvider(provider);
  const ctx = getRequestContext(c);
  const userId = ctx.userId;
  const organizationId = ctx.organizationId;
  const owner = param(c, "owner");
  const repo = param(c, "repo");

  const strategy = VcsStrategyFactory.getStrategy(provider);
  const data = await strategy.registerWebhook(ctx, owner, repo);

  if (organizationId) {
    audit.recordAsync(auditContextFrom(c, organizationId, userId), {
      eventType: `${provider}.webhook.register` as any,
      resourceType: provider,
      resourceId: `${owner}/${repo}`,
      after: {
        owner,
        repo,
        hookId: (data as { id?: number | string })?.id ?? null,
      },
    });
  }

  return c.json({ data });
}

export const deleteWebhook = (provider: string) => async (c: Context) => {
  validateProvider(provider);
  const ctx = getRequestContext(c);
  const owner = param(c, "owner");
  const repo = param(c, "repo");
  const body = await c.req.json();

  if (!body.hookId) {
    return c.json({ error: "hookId is required" }, 400);
  }

  const strategy = VcsStrategyFactory.getStrategy(provider);
  await strategy.deleteWebhook(ctx, owner, repo, body.hookId);

  if (ctx.organizationId) {
    audit.recordAsync(auditContextFrom(c, ctx.organizationId, ctx.userId), {
      eventType: `${provider}.webhook.delete` as any,
      resourceType: provider,
      resourceId: `${owner}/${repo}`,
      before: { owner, repo, hookId: body.hookId },
    });
  }
  return c.json({ success: true });
}
