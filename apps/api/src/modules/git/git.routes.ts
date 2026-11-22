import { Hono, type Context } from "hono";
import { Type } from "@sinclair/typebox";
import { GitCollectionSchemas } from "@repo/contracts";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operationContext, operationData } from "../../lib/operation-context";
import { secureRouter } from "../../lib/secure-router";

const r = secureRouter(new Hono(), { module: "git", basePath: "/api/git" });
const read = {
  tag: "git:read" as const,
  authorizationHandledByOperation: true,
  auditHandledByOperation: true,
};
const ops = () => getPlatformKernel().git;
const target = (c: Context) => ({
  provider: c.req.param("provider")!,
  owner: c.req.param("owner")!,
  repo: c.req.param("repo")!,
  serverId: c.req.query("serverId"),
});

r.get(
  "/:provider/repos",
  {
    ...read,
    mcp: {
      description: "List repositories for a connected Git provider, scoped to the caller’s grants.",
    },
    query: Type.Omit(GitCollectionSchemas.listRepos.input, ["provider"]),
  },
  async (c) =>
    c.json(
      await operationData(
        c,
        ops().listRepos(operationContext(c), {
          provider: c.req.param("provider")!,
          owner: c.req.query("owner"),
          page: c.req.query("page") === undefined ? undefined : Number(c.req.query("page")),
          perPage:
            c.req.query("perPage") === undefined ? undefined : Number(c.req.query("perPage")),
          search: c.req.query("search"),
          visibility: c.req.query("visibility") as "all" | "public" | "private" | undefined,
          sort: c.req.query("sort") as "updated" | "name" | "stars" | undefined,
        }),
      ),
    ),
);
r.get(
  "/:provider/repos/:owner/:repo",
  {
    ...read,
    mcp: { description: "Get repository metadata from the selected Git provider." },
    query: Type.Omit(GitCollectionSchemas.getRepo.input, ["provider", "owner", "repo"]),
  },
  async (c) =>
    c.json({
      data: await operationData(
        c,
        ops().getRepo(operationContext(c), {
          ...target(c),
          branches: c.req.query("branches") === "true",
        }),
      ),
    }),
);
r.get(
  "/:provider/repos/:owner/:repo/branches",
  {
    ...read,
    mcp: { description: "List repository branches from the selected Git provider." },
    query: Type.Omit(GitCollectionSchemas.listBranches.input, ["provider", "owner", "repo"]),
  },
  async (c) =>
    c.json(
      await operationData(
        c,
        ops().listBranches(operationContext(c), {
          ...target(c),
          page: Number(c.req.query("page") ?? 1),
        }),
      ),
    ),
);
r.get(
  "/:provider/repos/:owner/:repo/files",
  {
    ...read,
    source: "content-tree",
    mcp: { description: "List repository files within the caller’s granted source paths." },
    query: Type.Omit(GitCollectionSchemas.listFiles.input, ["provider", "owner", "repo"]),
  },
  async (c) =>
    c.json({
      data: await operationData(
        c,
        ops().listFiles(operationContext(c), {
          ...target(c),
          branch: c.req.query("branch"),
          path: c.req.query("path"),
        }),
      ),
    }),
);
r.get(
  "/:provider/repos/:owner/:repo/tree",
  {
    ...read,
    source: "content-tree",
    mcpExcluded: "Recursive dashboard picker. Use path-scoped files for bounded browsing.",
  },
  async (c) =>
    c.json({
      data: await operationData(
        c,
        ops().listTree(operationContext(c), {
          ...target(c),
          branch: c.req.query("branch"),
        }),
      ),
    }),
);
r.get(
  "/:provider/repos/:owner/:repo/file",
  {
    ...read,
    source: "content",
    mcp: {
      description:
        "Read a repository file within the caller’s granted source paths. Prefer detect for derived deployment settings.",
    },
    query: Type.Omit(GitCollectionSchemas.getFile.input, ["provider", "owner", "repo"]),
  },
  async (c) =>
    c.json({
      data: await operationData(
        c,
        ops().getFile(operationContext(c), {
          ...target(c),
          branch: c.req.query("branch"),
          file: c.req.query("file")!,
        }),
      ),
    }),
);
r.get(
  "/:provider/repos/:owner/:repo/detect",
  {
    ...read,
    mcp: {
      description:
        "Detect deployment settings without exposing repository file content or environment secrets.",
    },
    query: Type.Omit(GitCollectionSchemas.detectStack.input, ["provider", "owner", "repo"]),
  },
  async (c) =>
    c.json({
      data: await operationData(
        c,
        ops().detectStack(operationContext(c), {
          ...target(c),
          branch: c.req.query("branch"),
          composePath: c.req.query("composePath"),
        }),
      ),
    }),
);
r.post(
  "/:provider/repos/:owner/:repo/changes",
  {
    ...read,
    tag: "git:write",
    body: Type.Omit(GitCollectionSchemas.publishChange.input, ["provider", "owner", "repo"]),
    bodyValidatedByOperation: true,
    source: "write",
    mcp: {
      description:
        "Publish reviewed repository file changes using the selected provider. Requires source write access to every changed path.",
    },
  },
  async (c) =>
    c.json({
      data: await operationData(
        c,
        ops().publishChange(operationContext(c), {
          ...(await c.req.json()),
          provider: c.req.param("provider")!,
          owner: c.req.param("owner")!,
          repo: c.req.param("repo")!,
        }),
      ),
    }),
);

export const gitRoutes = r.hono;
