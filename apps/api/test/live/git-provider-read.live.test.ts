/** Read-only live coverage for the HTTP SDK and repository adapter in both runtime modes. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assembleGitClone } from "@repo/adapters";
import { getGitProvider } from "@repo/platform/engine/modules/git/provider";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterAll, beforeAll, expect, it } from "vitest";
import { repos } from "@repo/db";
import { OpenshipClient } from "@repo/sdk/client";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { env } from "@repo/platform/engine/config/env";
import { gitRoutes } from "../../src/modules/git/git.routes";
import { healthRoutes } from "../../src/modules/health/health.routes";
import { handleApiError } from "../../src/middleware/error-handler";
import { seedOwner } from "../modules/jobs/_harness";

const target = { provider: "github", owner: "oblien", repo: "openship-badge-demo" };
let server: ReturnType<typeof serve> | undefined;
const originalMode = env.CLOUD_MODE;

beforeAll(async () => {
  const app = new Hono()
    .onError(handleApiError)
    .route("/api/health", healthRoutes)
    .route("/api/git", gitRoutes);
  server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  if (!server.listening) await once(server, "listening");
});

afterAll(async () => {
  env.CLOUD_MODE = originalMode;
  if (server?.listening) {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});

function liveClient(owner: Awaited<ReturnType<typeof seedOwner>>) {
  const address = server?.address();
  if (!address || typeof address === "string") throw new Error("Expected a loopback HTTP listener");
  return new OpenshipClient({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: owner.token,
    organizationId: owner.orgId,
  });
}

it.each([false, true])(
  "reads the public demo through a saved connection with Cloud mode=%s",
  async (cloud) => {
    env.CLOUD_MODE = cloud;
    const owner = await seedOwner();
    const token =
      process.env.GH_TOKEN ||
      execFileSync("gh", ["auth", "token"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    await repos.settings.upsert({
      id: randomUUID(),
      userId: owner.userId,
      cloneTokenEncrypted: encrypt(token),
      cloneTokenAsDefault: true,
    });
    const client = liveClient(owner);
    const repo = await client.git.getRepo(target);
    expect(repo).toMatchObject({ owner: target.owner, name: target.repo, private: false });
    const source = { ...target, branch: repo.default_branch };
    const branches = await client.git.listBranches(target);
    expect(branches.data.some((row) => row.name === source.branch)).toBe(true);
    const manifest = await client.git.getFile({ ...source, file: "package.json" });
    expect(JSON.parse(manifest.content)).toMatchObject({ name: target.repo });
    expect(await client.git.detectStack(source)).toMatchObject({ stack: "nextjs" });
  },
);

it.each([false, true])(
  "reads a real GitLab project through the SDK with Cloud mode=%s",
  async (cloud) => {
    env.CLOUD_MODE = cloud;
    const client = liveClient(await seedOwner());
    const target = { provider: "gitlab", owner: "gitlab-org/charts", repo: "gitlab" };
    const repo = await client.git.getRepo(target);
    expect(repo).toMatchObject({ owner: target.owner, name: target.repo, private: false });
    const branches = await client.git.listBranches(target);
    expect(branches.data[0].sha).toMatch(/^[a-f0-9]{40,64}$/);
    const file = await client.git.getFile({
      ...target,
      file: "Chart.yaml",
      branch: repo.default_branch,
    });
    expect(file.content).toContain("name: gitlab");
    // Exercise the normal deploy scanner on a small application with a real entry point.
    expect(
      await client.git.detectStack({
        provider: "gitlab",
        owner: "gitlab-examples",
        repo: "nodejs",
      }),
    ).toMatchObject({ stack: "node" });
  },
);

it("checks out a public GitLab repository using the deployment clone credentials and transport", async () => {
  const owner = await seedOwner();
  const ctx = buildBackgroundContext({
    userId: owner.userId,
    organizationId: owner.orgId,
    label: "live-git-clone",
  });
  const provider = getGitProvider("gitlab");
  const ref = { provider: provider.id, namespace: "gitlab-org/charts", name: "gitlab" };
  const repoUrl = await provider.cloneUrl(owner.orgId, ref);
  const grant = await provider.resolveCloneCredentials({
    ctx,
    projectId: "live",
    repoUrl,
    owner: ref.namespace,
    repo: ref.name,
    buildStrategy: "local",
  });
  expect(grant).toEqual({ anonymous: true });
  const clone = assembleGitClone({
    repoUrl,
    gitToken: grant.token,
    gitTokenRepositories: grant.tokenRepositories,
  });
  const dir = await mkdtemp(join(tmpdir(), "openship-gitlab-clone-"));
  try {
    execFileSync(
      "git",
      [
        ...clone.credArgs,
        "clone",
        "--depth=1",
        "--filter=blob:none",
        "--no-checkout",
        "--",
        clone.cloneUrl,
        dir,
      ],
      {
        env: { ...process.env, ...clone.env },
        stdio: "pipe",
        timeout: 60_000,
      },
    );
    const chart = execFileSync("git", ["-C", dir, "show", "HEAD:Chart.yaml"], {
      env: { ...process.env, ...clone.env },
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(chart).toContain("name: gitlab");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
