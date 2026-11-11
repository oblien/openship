import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { createShip, type VerifiedIdentity } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { updatesRoutes } from "../../src/modules/updates/updates.routes";
import { healthRoutes } from "../../src/modules/health/health.routes";
import { handleApiError } from "../../src/middleware/error-handler";
import { repos, seedOwner, installFakeRunner, type SeededOwner } from "../modules/jobs/_harness";

installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .route("/api/updates", updatesRoutes)
  .route("/api/health", healthRoutes);
export async function sourceClients(
  owner: SeededOwner,
  organizationId = owner.orgId,
  limits: Partial<VerifiedIdentity> = {},
) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: { resolve: async () => ({ user, sessionId: "runtime-source", ...limits }) },
  });
  return {
    native: await ship.scope({ identity: "verified", organizationId }),
    remote: new OpenshipClient({
      baseUrl: "http://openship.test",
      token: owner.token,
      organizationId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    }),
  };
}

/** In-memory GitHub transport; all product authorization, parsing and publishing stay real. */
export async function sourceFixture(
  files: Record<string, string> = {
    Dockerfile: 'FROM node:22.23.3-alpine\nCMD ["node", "--version"]\n',
  },
) {
  const owner = await seedOwner();
  const group = await repos.projectGroup.create({
    organizationId: owner.orgId,
    name: "Source update",
    slug: randomUUID(),
  });
  const project = await repos.project.create({
    organizationId: owner.orgId,
    groupId: group.id,
    name: "Source update",
    slug: randomUUID(),
    gitOwner: "acme",
    gitRepo: "app",
    gitProvider: "github",
    gitBranch: "main",
    buildKind: "dockerfile",
  });
  const git = {
    head: "a".repeat(40),
    tree: "b".repeat(40),
    commit: "d".repeat(40),
    writes: [] as { path: string; params: Record<string, unknown> }[],
    files,
    proposed: {} as Record<string, string>,
    refs: new Set<string>(),
  };
  const fetch = async ({
    url,
    params = {},
    method = "GET",
  }: {
    url: string;
    params?: Record<string, unknown>;
    method?: string;
  }) => {
    const path = decodeURIComponent(new URL(url).pathname.replace("/repos/acme/app", ""));
    if (method !== "GET") git.writes.push({ path, params });
    if (path === "/branches/main")
      return { name: "main", commit: { sha: git.head }, protected: false };
    if (path.startsWith("/contents/")) {
      if (params.ref !== git.head) throw new Error("Unexpected source revision");
      const content = git.files[path.slice("/contents/".length)];
      if (content === undefined) throw new Error("GitHub API error (404)");
      return {
        content: Buffer.from(content).toString("base64"),
        size: Buffer.byteLength(content),
        sha: git.tree,
        type: "file",
      };
    }
    if (path === "/git/ref/heads/main") return { object: { sha: git.head } };
    if (path === `/git/commits/${git.head}`) return { tree: { sha: git.tree } };
    if (path === `/git/trees/${git.tree}`)
      return {
        truncated: false,
        tree: Object.keys(git.files).map((path) => ({ path, mode: "100644", type: "blob" })),
      };
    if (path === "/git/trees") {
      for (const file of params.tree as { path: string; content: string }[])
        git.proposed[file.path] = file.content;
      return { sha: "c".repeat(40) };
    }
    if (path === "/git/commits")
      return { sha: git.commit, html_url: `https://github.com/acme/app/commit/${git.commit}` };
    if (path === "/git/refs") {
      const ref = params.ref as string;
      if (git.refs.has(ref)) throw new Error("GitHub API error (422): Reference already exists");
      git.refs.add(ref);
      return {};
    }
    if (path === "/pulls") return { html_url: "https://github.com/acme/app/pull/42" };
    throw new Error(`Unexpected GitHub call: ${path}`);
  };
  return { owner, project, git, fetch, clients: await sourceClients(owner) };
}
