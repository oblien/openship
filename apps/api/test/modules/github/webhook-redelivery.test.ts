import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, eq, repos, schema } from "@repo/db";
import { seedOrg, seedProject, seedDeployment, seedService } from "../../helpers/seed";
import { encrypt } from "@repo/platform/engine/lib/encryption";
import { notification } from "@repo/platform/engine/lib/notification-dispatcher";
import { env } from "@repo/platform/engine/config/env";
import { registerWebhookProvider } from "@repo/platform/engine/modules/webhooks/webhook.service";
import { githubWebhookProvider } from "../../../src/modules/github/github.webhook";
import { webhookRoutes } from "../../../src/modules/webhooks/webhook.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

const dispatch = vi.hoisted(() => vi.fn());
const getRepository = vi.hoisted(() => vi.fn());
const impactIO = vi.hoisted(() => ({ compare: vi.fn(), read: vi.fn(), tree: vi.fn() }));
vi.mock("@repo/platform/engine/modules/deployments/build.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/deployments/build.service")>()),
  triggerDeployment: dispatch,
}));
vi.mock("@repo/platform/engine/modules/github/github.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/github/github.service")>()),
  getRepository,
  compareCommits: impactIO.compare, getFileContent: impactIO.read, listRepositoryTree: impactIO.tree,
}));
vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({
  notification: { emit: vi.fn() },
}));

// The real signed HTTP ingress, provider, organization actor, repository and
// delivery ledger run together. Stop only at deployment execution / GitHub IO.
// app.request has no TCP peer; retain the public ingress rate-limit policy
// while supplying the trusted peer that the application resolves in production.
const app = new Hono()
  .onError(handleApiError)
  .use("*", async (c, next) => {
    c.set("clientIp", "192.0.2.124");
    await next();
  })
  .route("/api/webhooks", webhookRoutes);
let sequence = 0;
beforeEach(() => {
  dispatch.mockReset().mockResolvedValue({ deployment: { id: "started-deployment" } });
  getRepository.mockReset().mockResolvedValue({ default_branch: "master" });
  registerWebhookProvider(githubWebhookProvider);
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const { organizationId, userId } = await seedOrg();
  const repo = `redelivery-${sequence++}`;
  const secret = "test-only-github-webhook-secret";
  const fields = {
    gitOwner: "acme",
    gitRepo: repo,
    gitBranch: "main",
    autoDeploy: true,
    webhookSecret: encrypt(secret),
  };
  const project = await seedProject(organizationId, fields);
  const body = {
    ref: "refs/heads/main",
    before: "1".repeat(40),
    after: "2".repeat(40),
    head_commit: {
      id: "2".repeat(40),
      message: "Fix",
      added: [],
      modified: ["app.ts"],
      removed: [],
    },
    commits: [{ added: [], modified: ["app.ts"], removed: [] }],
    repository: {
      name: repo,
      full_name: `acme/${repo}`,
      owner: { login: "acme" },
      default_branch: "main",
    },
  };
  const send = (deliveryId: string, signatureValid = true) => {
    const payload = JSON.stringify(body);
    return app.request("/api/webhooks/github", {
      method: "POST",
      body: payload,
      headers: {
        "content-type": "application/json",
        "x-github-event": "push",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": `sha256=${createHmac(
          "sha256",
          signatureValid ? secret : "wrong-secret",
        )
          .update(payload)
          .digest("hex")}`,
      },
    });
  };
  const deliveryId = `delivery-${repo}`;
  const anchor = async () =>
    (
      await db
        .select()
        .from(schema.webhookDelivery)
        .where(eq(schema.webhookDelivery.deliveryId, deliveryId))
    )[0];
  return { organizationId, userId, fields, project, body, send, deliveryId, anchor };
}

describe("GitHub blocked deployment redelivery (#847)", () => {
  it("reports a blocked push as failed, records it, then accepts redelivery of the same id", async () => {
    const f = await fixture();
    // Neither a different branch nor a disabled sibling should be dispatched.
    await seedProject(f.organizationId, { ...f.fields, gitBranch: "develop" });
    await seedProject(f.organizationId, { ...f.fields, autoDeploy: false });
    dispatch.mockRejectedValueOnce(new Error("Clone credential unavailable"));
    const rejected = await f.send(f.deliveryId);
    expect(rejected.status).toBe(500);
    expect(await rejected.json()).toMatchObject({
      success: false,
      message: expect.stringContaining("1 failed"),
    });
    expect(await f.anchor()).toMatchObject({
      outcome: "failed",
      statusCode: 500,
      processedAt: expect.any(Date),
    });
    expect((await repos.webhookDelivery.listByProject(f.project.id)).rows).toEqual([
      expect.objectContaining({ outcome: "failed", error: "Clone credential unavailable" }),
    ]);
    expect(dispatch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ userId: f.userId, organizationId: f.organizationId }),
      expect.objectContaining({
        projectId: f.project.id,
        commitSha: "2".repeat(40),
        trigger: "webhook",
      }),
    );

    const retried = await f.send(f.deliveryId);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ success: true });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(await f.anchor()).toMatchObject({ outcome: "received", statusCode: 200, error: null });
    expect((await f.send(f.deliveryId)).status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it("retries only blocked siblings after a partially successful push", async () => {
    const f = await fixture();
    const other = await seedProject(f.organizationId, f.fields);
    dispatch.mockImplementation(async (_ctx, input) => {
      if (input.projectId === other.id) throw new Error("Clone credential unavailable");
      return { deployment: { id: "successful-sibling" } };
    });
    const response = await f.send(f.deliveryId);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      success: false,
      message: expect.stringMatching(/Triggered 1 .*1 failed/),
    });
    expect((await repos.webhookDelivery.listByProject(f.project.id)).rows[0].outcome).toBe(
      "dispatched",
    );
    expect((await repos.webhookDelivery.listByProject(other.id)).rows[0].outcome).toBe("failed");
    expect(await f.anchor()).toMatchObject({
      summary: { handledProjectIds: [f.project.id] },
    });

    // The first sibling can have advanced to a newer commit before the operator
    // retries; the current-commit guard cannot make an old delivery idempotent.
    dispatch.mockResolvedValue({ deployment: { id: "previously-blocked-sibling" } });
    expect((await f.send(f.deliveryId)).status).toBe(200);
    expect(
      dispatch.mock.calls.filter(([, input]) => input.projectId === f.project.id),
    ).toHaveLength(1);
    expect(
      dispatch.mock.calls.filter(([, input]) => input.projectId === other.id),
    ).toHaveLength(2);
    expect(await f.anchor()).toMatchObject({ outcome: "received", statusCode: 200 });

    // Completion is scoped to this delivery; the next push still deploys both.
    f.body.head_commit.id = "3".repeat(40);
    f.body.after = "3".repeat(40);
    expect((await f.send(`${f.deliveryId}-next-push`)).status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(5);
  });

  it("does not block a different branch delivery while one branch is dispatching", async () => {
    const f = await fixture();
    const develop = await seedProject(f.organizationId, { ...f.fields, gitBranch: "develop" });
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    dispatch.mockImplementation(async (_ctx, input) => {
      if (input.projectId === f.project.id) await pending;
      return { deployment: { id: "started-deployment" } };
    });
    const main = f.send(f.deliveryId);
    try {
      await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
      f.body.ref = "refs/heads/develop";
      expect((await f.send(`${f.deliveryId}-develop`)).status).toBe(200);
      expect(dispatch).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ userId: f.userId, organizationId: f.organizationId }),
        expect.objectContaining({ projectId: develop.id, branch: "develop" }),
      );
    } finally {
      release();
    }
    expect((await main).status).toBe(200);
  });

  it("records an unexpected handler exception as retryable instead of acknowledging success", async () => {
    const f = await fixture();
    // Verification reads the project first; failure occurs inside the handler.
    const lookup = vi
      .spyOn(repos.project, "findByGitRepo")
      .mockResolvedValueOnce([f.project])
      .mockRejectedValueOnce(new Error("storage unavailable"));
    const response = await f.send(f.deliveryId);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ success: false, error: "storage unavailable" });
    expect(await f.anchor()).toMatchObject({ outcome: "failed", error: "storage unavailable" });
    lookup.mockRestore();
    expect((await f.send(f.deliveryId)).status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid signature before claiming the delivery or invoking deployment", async () => {
    const f = await fixture();
    expect((await f.send(f.deliveryId, false)).status).toBe(401);
    expect(await f.anchor()).toBeUndefined();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "resolves a legacy project's default branch with payload metadata present=%s",
    async (payloadHasDefault) => {
      const f = await fixture();
      await repos.project.update(f.project.id, { gitBranch: null });
      f.body.ref = "refs/heads/master";
      if (payloadHasDefault) f.body.repository.default_branch = "master";
      else delete (f.body.repository as { default_branch?: string }).default_branch;
      const response = await f.send(f.deliveryId);
      expect(response.status).toBe(200);
      expect(dispatch).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ userId: f.userId, organizationId: f.organizationId }),
        expect.objectContaining({ projectId: f.project.id, branch: "master" }),
      );
      expect(getRepository).toHaveBeenCalledTimes(payloadHasDefault ? 0 : 1);
    },
  );
});


describe("pushes queued by deployment admission", () => {
  it("acknowledges a durable queued push without a failure notice or duplicate delivery", async () => {
    const f = await fixture();
    dispatch.mockResolvedValue({ deployment: undefined, skipped: true, queuedPush: true,
      awaitingActions: { id: "queued-request", projectId: f.project.id } });
    vi.mocked(notification.emit).mockClear();
    const response = await f.send(f.deliveryId);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true,
      message: expect.stringContaining("1 queued behind a running deployment") });
    expect(notification.emit).not.toHaveBeenCalled();
    expect((await f.send(f.deliveryId)).status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });
});

describe("single-root workspace push decisions (#1339)", () => {
  const manifests: Record<string, unknown> = {
    "package.json": { workspaces: ["apps/*", "packages/*"] },
    "apps/storefront/package.json": { name: "storefront", dependencies: { ui: "workspace:*" } },
    "apps/admin/package.json": { name: "admin" },
    "packages/ui/package.json": { name: "ui" },
  };
  async function workspace() {
    const f = await fixture();
    const active = await seedDeployment(f.project, { commitSha: "1".repeat(40) });
    await repos.project.update(f.project.id, {
      rootDirectory: "apps/storefront",
      activeDeploymentId: active.id,
    });
    f.body.commits[0]!.modified = ["apps/admin/page.tsx"];
    impactIO.compare
      .mockReset()
      .mockResolvedValue({ files: ["apps/admin/page.tsx"], truncated: false });
    impactIO.read.mockReset().mockImplementation(async (_ctx, _owner, _repo, path, options) => {
      expect(options.branch).toBe("2".repeat(40));
      if (!(path in manifests)) throw Object.assign(new Error("Not found"), { status: 404 });
      return { content: JSON.stringify(manifests[path]), size: 100 };
    });
    impactIO.tree
      .mockReset()
      .mockResolvedValue(Object.keys(manifests).map((path) => ({ path, type: "file" })));
    return f;
  }
  it.each([false, true])(
    "skips an unrelated app and records why with Cloud mode=%s",
    async (cloud) => {
      const previous = env.CLOUD_MODE;
      env.CLOUD_MODE = cloud;
      try {
        const f = await workspace();
        expect((await f.send(f.deliveryId)).status).toBe(200);
        expect(dispatch).not.toHaveBeenCalled();
        expect((await repos.webhookDelivery.listByProject(f.project.id)).rows).toContainEqual(
          expect.objectContaining({
            outcome: "skipped",
            summary: expect.objectContaining({ reason: "unrelated-workspaces" }),
          }),
        );
      } finally {
        env.CLOUD_MODE = previous;
      }
    },
  );
  it.each([
    { rootDirectory: "", compose: false, paths: ["README.md", "AGENTS.md"], deploy: false },
    { rootDirectory: "", compose: true, paths: ["README.md", "AGENTS.md"], deploy: false },
    { rootDirectory: "apps/storefront", compose: true, paths: ["apps/storefront/README.md"], deploy: false },
    { rootDirectory: "", compose: false, paths: ["pocketbase/pb_migrations/new.js"], deploy: false },
    { rootDirectory: "", compose: false, paths: ["README.md", "app.ts"], deploy: true },
    { rootDirectory: "", compose: true, paths: ["README.md", "app.ts"], deploy: true },
  ])("applies path policy at the webhook boundary: %j", async ({ rootDirectory, compose, paths, deploy }) => {
    const f = await workspace();
    await repos.project.update(f.project.id, { rootDirectory });
    if (compose) await seedService(f.project.id, { name: "web", kind: "compose", rootDirectory: "." });
    impactIO.read.mockImplementation(async () => ({ content: JSON.stringify({
      autoDeployPaths: { exclude: ["**/README.md", "**/AGENTS.md", "pocketbase/**"] },
    }), size: 100 }));
    f.body.commits[0]!.modified = ["README.md"];
    impactIO.compare.mockResolvedValue({ files: paths, truncated: false });
    expect((await f.send(f.deliveryId)).status).toBe(200);
    expect(dispatch).toHaveBeenCalledTimes(deploy ? 1 : 0);
  });
  it("builds a dependent shared package", async () => {
    const f = await workspace();
    impactIO.compare.mockResolvedValue({ files: ["packages/ui/index.ts"], truncated: false });
    expect((await f.send(f.deliveryId)).status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
    expect((await repos.webhookDelivery.listByProject(f.project.id)).rows).toContainEqual(
      expect.objectContaining({
        outcome: "dispatched",
        summary: expect.objectContaining({ reason: "workspace-dependency" }),
      }),
    );
  });
  it("includes app changes since the active release even if this push only touched another app", async () => {
    const f = await workspace();
    // An intermediate app commit failed. Its app file is absent from THIS push.
    f.body.before = "3".repeat(40);
    impactIO.compare.mockResolvedValue({
      files: ["apps/admin/page.tsx", "apps/storefront/page.tsx"],
      truncated: false,
    });
    expect((await f.send(f.deliveryId)).status).toBe(200);
    expect(impactIO.compare).toHaveBeenCalledWith(
      expect.anything(),
      "acme",
      f.fields.gitRepo,
      "1".repeat(40),
      "2".repeat(40),
    );
    expect(dispatch).toHaveBeenCalledOnce();
  });
  it.each(["first-deploy", "unknown-diff", "truncated-diff", "force-token", "force-next"])(
    "does not suppress %s",
    async (reason) => {
      const f = await workspace();
      if (reason === "first-deploy")
        await repos.project.update(f.project.id, { activeDeploymentId: null });
      if (reason === "unknown-diff") impactIO.compare.mockResolvedValue(null);
      if (reason === "truncated-diff")
        impactIO.compare.mockResolvedValue({ files: ["apps/admin/page.tsx"], truncated: true });
      if (reason === "force-token") f.body.head_commit.message = "[force-deploy]";
      if (reason === "force-next")
        await repos.project.update(f.project.id, { forceDeployNext: true });
      expect((await f.send(f.deliveryId)).status).toBe(200);
      expect(dispatch).toHaveBeenCalledOnce();
      if (reason.startsWith("force"))
        expect(dispatch.mock.calls[0]![1]).toMatchObject({ forceAll: true });
    },
  );
});
