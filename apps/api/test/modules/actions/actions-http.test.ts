import "../jobs/_env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHmac } from "node:crypto";
import { initPlatform, resetPlatform, type CommandExecutor } from "@repo/adapters";
import { generateId } from "@repo/core";
import { eq } from "@repo/db";
import { seedOwner, seedServer, db, schema, repos, type SeededOwner } from "../jobs/_harness";

vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return {
    ...actual,
    env: { ...actual.env, GITHUB_WEBHOOK_SECRET: "actions-app-webhook-test-secret" },
  };
});

vi.mock("@repo/platform/engine/lib/server-execution", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/server-execution")>()),
  withServerExecution: async (
    _org: string,
    _id: string,
    operation: (exec: CommandExecutor) => unknown,
  ) =>
    operation({
      exec: async () => "Darwin\narm64\ngit=yes\nnode=yes\nversion=15.5\n",
    } as unknown as CommandExecutor),
}));
vi.mock("@repo/platform/engine/modules/github/github.auth", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/github/github.auth")>()),
  githubFetch: async ({ url }: { url: string }) => {
    if (url.includes("/git/matching-refs/heads/")) return [{ ref: "refs/heads/main" }];
    if (url.includes("/commits/")) return { sha: "a".repeat(40) };
    if (url.match(/\/repos\/acme\/app$/))
      return { full_name: "acme/app", default_branch: "main", private: true, id: 10 };
    throw new Error(`Unexpected GitHub fixture request ${url}`);
  },
}));
import { actionRoutes } from "../../../src/modules/actions/action.routes";
import {
  actionRuntimeRoutes,
  actionTwirpRoutes,
} from "../../../src/modules/actions/action-runtime.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { scanRoutes } from "../../../src/lib/route-scanner";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { decrypt } from "@repo/platform/engine/lib/encryption";
import {
  captureExecutionAuthority,
  resolveExecutionAuthority,
} from "@repo/platform/engine/lib/execution-authority";
import { registerWebhookProvider } from "@repo/platform/engine/modules/webhooks/webhook.service";
import {
  actionWebhookInbox,
  dispatchActionWebhook,
} from "@repo/platform/engine/modules/actions/triggers";
import { githubWebhookProvider } from "../../../src/modules/github/github.webhook";
import { webhookRoutes } from "../../../src/modules/webhooks/webhook.routes";

const app = new Hono();
// Match the connection context installed by the real API's proxy middleware.
app.use("*", (c, next) => {
  c.set("clientIp" as never, "127.0.0.1");
  return next();
});
app.onError(handleApiError);
app.route("/api/actions", actionRoutes);
app.route("/api/actions/runtime", actionRuntimeRoutes);
app.route("/twirp", actionTwirpRoutes);
app.route("/api/webhooks", webhookRoutes);
beforeAll(async () => {
  await initPlatform({ target: "selfhosted", runtime: "docker" });
  registerWebhookProvider(githubWebhookProvider);
});
afterAll(async () => {
  await flushAudit();
  resetPlatform();
});

const source =
  "name: CI\non: workflow_dispatch\njobs:\n  test:\n    runs-on: [self-hosted, macos]\n    steps:\n      - run: echo done\n";
const config = {
  mode: "native" as const,
  labels: ["macos-latest"],
  image: null,
  cpu: 1,
  memoryMb: 1024,
  maxParallel: 1,
  allowDockerSocket: false,
};
async function clients(owner: SeededOwner) {
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({
    platform: getPlatformKernel(),
    identity: {
      resolve: async () => ({
        user: { id: user.id, email: user.email, name: user.name },
        sessionId: "actions-test",
        credential: { organizationId: owner.orgId, readOnly: false },
      }),
    },
  });
  const native = await ship.scope({ identity: "verified", organizationId: owner.orgId });
  const remote = new OpenshipClient({
    baseUrl: "http://openship.test",
    token: owner.token,
    fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
  });
  return { native: native.actions, remote: remote.actions };
}
async function fixture() {
  const owner = await seedOwner();
  const serverId = await seedServer(owner.orgId);
  const c = await clients(owner);
  const runner = await c.remote.addRunner({ name: "Build Mac", serverId, config });
  const input = {
    name: "CI",
    owner: "acme",
    repo: "app",
    path: ".github/workflows/ci.yml",
    ref: "main",
    source,
    runnerIds: [runner.id],
    secrets: { DEPLOY_TOKEN: "private-workflow-value" },
  };
  const workflow = await c.remote.create(input);
  return { ...c, owner, serverId, runner, workflow, input };
}

describe("Actions HTTP, native SDK and authorization", () => {
  it("passes the production route scanner and rejects anonymous API and runtime requests", async () => {
    expect(scanRoutes(app).errors).toEqual([]);
    for (const path of ["/api/actions/workflows", "/api/actions/runners", "/api/actions/runs"])
      expect((await app.request(path)).status).toBe(401);
    for (const path of [
      "/twirp/github.actions.results.api.v1.ArtifactService/ListArtifacts",
      "/api/actions/runtime/_apis/artifactcache/caches",
    ]) {
      const response = await app.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status, await response.text()).toBe(401);
    }
  });

  it("uses the same encrypted workflow, capability probe and immutable dispatch through both SDKs", async () => {
    const f = await fixture();
    expect(f.runner.capabilities).toMatchObject({
      os: "macos",
      architecture: "arm64",
      docker: false,
    });
    expect(await f.native.get(f.workflow.id)).toEqual(f.workflow);
    expect(f.workflow.secretNames).toEqual(["DEPLOY_TOKEN"]);
    expect(JSON.stringify(f.workflow)).not.toContain("private-workflow-value");
    const saved = (await repos.actions.workflow(f.owner.orgId, f.workflow.id))!;
    expect(saved.secrets.DEPLOY_TOKEN).not.toBe("private-workflow-value");
    expect(decrypt(saved.secrets.DEPLOY_TOKEN!)).toBe("private-workflow-value");
    const run = await f.native.dispatch(f.workflow.id, { idempotencyKey: "test-dispatch-once" });
    expect(run.revision).toBe("a".repeat(40));
    expect(run.ref).toBe("refs/heads/main");
    expect(
      (await f.remote.dispatch(f.workflow.id, { idempotencyKey: "test-dispatch-once" })).id,
    ).toBe(run.id);
    expect(await f.remote.getRun(run.id)).toEqual(run);
    await f.remote.cancel(run.id);
    expect((await f.native.getRun(run.id)).cancelRequestedAt).toBeTruthy();
    await flushAudit();
    const records = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.resourceId, f.workflow.id));
    expect(records.length).toBeGreaterThan(0);
    expect(JSON.stringify(records)).not.toContain("private-workflow-value");
  });

  it("conceals another organization's workflows, runs, logs and artifact access", async () => {
    const f = await fixture();
    const bob = await seedOwner();
    const b = await clients(bob);
    const run = await f.native.dispatch(f.workflow.id, { idempotencyKey: "tenant-run-one" });
    const jobId = generateId("ajob");
    await db
      .insert(schema.actionJob)
      .values({
        id: jobId,
        runId: run.id,
        organizationId: f.owner.orgId,
        jobKey: "test",
        matrixIndex: 0,
      });
    for (const client of [b.native, b.remote]) {
      expect(await client.list()).toEqual([]);
      expect(await client.listRuns()).toEqual([]);
      for (const call of [
        () => client.get(f.workflow.id),
        () => client.update(f.workflow.id, f.input),
        () => client.dispatch(f.workflow.id, { idempotencyKey: "cross-tenant-dispatch" }),
        () => client.getRun(run.id),
        () => client.cancel(run.id),
        () => client.approve(run.id),
        () => client.jobEvents(jobId),
        () => client.artifacts(run.id),
        () => client.artifactDownload(run.id, { artifactId: 1 }),
      ])
        await expect(call()).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    const bobServer = await seedServer(bob.orgId);
    await expect(
      f.remote.addRunner({ serverId: bobServer, name: "Foreign", config }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("requires server administration and repository access in addition to workflow permissions", async () => {
    const f = await fixture();
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.userId, f.owner.userId));
    await repos.resourceGrant.upsert({
      organizationId: f.owner.orgId,
      userId: f.owner.userId,
      resourceType: "job",
      resourceId: "*",
      permissions: ["admin"],
      grantedByUserId: null,
    });
    await expect(
      f.remote.dispatch(f.workflow.id, { idempotencyKey: "restricted-dispatch" }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await repos.resourceGrant.upsert({
      organizationId: f.owner.orgId,
      userId: f.owner.userId,
      resourceType: "github_repository",
      resourceId: "acme/app",
      permissions: ["read"],
      grantedByUserId: null,
    });
    await expect(
      f.remote.dispatch(f.workflow.id, { idempotencyKey: "restricted-dispatch" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await repos.resourceGrant.upsert({
      organizationId: f.owner.orgId,
      userId: f.owner.userId,
      resourceType: "server",
      resourceId: f.serverId,
      permissions: ["admin"],
      grantedByUserId: null,
    });
    expect(
      (await f.remote.dispatch(f.workflow.id, { idempotencyKey: "restricted-dispatch" })).status,
    ).toBe("queued");
  });

  it("rejects unsupported capabilities and malformed YAML before saving a destination or workflow", async () => {
    const owner = await seedOwner();
    const c = await clients(owner);
    const serverId = await seedServer(owner.orgId);
    await expect(
      c.remote.addRunner({
        name: "Mac Docker",
        serverId,
        config: { ...config, mode: "container", image: "node:22" },
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(await c.remote.runners()).toEqual([]);
    await expect(
      c.native.preview({
        source: source.replace(
          "runs-on: [self-hosted, macos]",
          "runs-on: [self-hosted, macos]\n    environment: production",
        ),
      }),
    ).rejects.toThrow("protected environments");
    const response = await app.request("/api/actions/workflows", {
      method: "POST",
      headers: { ...owner.auth, "content-type": "application/json" },
      body: JSON.stringify({ source, namespace: "reseller-namespace" }),
    });
    expect(response.status).toBe(400);
  });

  it("durably accepts only App-signed repository deliveries and prevents duplicate runs", async () => {
    const f = await fixture();
    const installationId = 912345;
    await db
      .insert(schema.gitInstallation)
      .values({
        id: generateId("git"),
        userId: f.owner.userId,
        organizationId: f.owner.orgId,
        owner: "acme",
        installationId,
      });
    await f.remote.update(f.workflow.id, {
      ...f.input,
      source: source.replace("on: workflow_dispatch", "on: [push, workflow_dispatch]"),
    });
    const event = {
      installation: { id: installationId },
      ref: "refs/heads/main",
      after: "b".repeat(40),
      before: "c".repeat(40),
      repository: {
        full_name: "acme/app",
        name: "app",
        owner: { login: "acme" },
        default_branch: "main",
      },
      sender: { login: "developer" },
    };
    const delivery = generateId("github");
    const body = JSON.stringify(event);
    const send = (secret: string, deliveryId = delivery) =>
      app.request("/api/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": "push",
          "x-github-delivery": deliveryId,
          "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
        },
      });
    expect((await send("invalid-secret")).status).toBe(401);
    expect(
      (
        await db
          .select()
          .from(schema.actionDelivery)
          .where(eq(schema.actionDelivery.workflowId, f.workflow.id))
      ).length,
    ).toBe(0);
    expect((await send("actions-app-webhook-test-secret")).status).toBe(200);
    expect((await send("actions-app-webhook-test-secret")).status).toBe(200);
    expect(
      (
        await db
          .select()
          .from(schema.actionDelivery)
          .where(eq(schema.actionDelivery.workflowId, f.workflow.id))
      ).length,
    ).toBe(1);
    expect(await repos.actions.runs(f.owner.orgId)).toEqual([]);
    await actionWebhookInbox.tick(new Date(Date.now() + 1));
    expect((await repos.actions.runs(f.owner.orgId)).map((run) => run.revision)).toEqual([
      event.after,
    ]);
    await actionWebhookInbox.tick(new Date(Date.now() + 1));
    expect((await repos.actions.runs(f.owner.orgId)).length).toBe(1);
    // A signature alone cannot turn another installation into this org's runner.
    await dispatchActionWebhook(
      "push",
      { ...event, installation: { id: 999 } },
      "wrong-installation",
      { organizationId: f.owner.orgId, workflowId: f.workflow.id },
    );
    expect((await repos.actions.runs(f.owner.orgId)).length).toBe(1);
  });

  it("keeps fork code awaiting approval with no saved secrets or variables", async () => {
    const f = await fixture();
    const installationId = 912346;
    const cloud = await repos.actions.saveRunner({
      id: generateId("runner"),
      organizationId: f.owner.orgId,
      name: "Disposable test",
      cloudPoolId: "test-fork-pool",
      config: { ...config, mode: "container", labels: ["ubuntu-latest"], image: "node:22" },
      capabilities: {
        os: "linux",
        architecture: "x64",
        docker: true,
        git: true,
        node: true,
        version: null,
        distribution: null,
      },
    });
    await db
      .insert(schema.gitInstallation)
      .values({
        id: generateId("git"),
        userId: f.owner.userId,
        organizationId: f.owner.orgId,
        owner: "acme",
        installationId,
      });
    await f.remote.update(f.workflow.id, {
      ...f.input,
      runnerIds: [cloud.id],
      allowForks: true,
      variables: { PRIVATE_VAR: "private" },
      source: source
        .replace("on: workflow_dispatch", "on: pull_request")
        .replace("[self-hosted, macos]", "ubuntu-latest"),
    });
    const event = {
      installation: { id: installationId },
      action: "opened",
      number: 42,
      repository: { full_name: "acme/app" },
      sender: { login: "contributor" },
      pull_request: {
        merge_commit_sha: "d".repeat(40),
        base: { sha: "e".repeat(40), ref: "main" },
        head: { repo: { full_name: "fork/app" } },
      },
    };
    await dispatchActionWebhook("pull_request", event, "fork-delivery", {
      organizationId: f.owner.orgId,
      workflowId: f.workflow.id,
    });
    const [run] = await repos.actions.runs(f.owner.orgId);
    expect(run).toMatchObject({
      untrusted: true,
      status: "waiting",
      approvedAt: null,
      revision: "d".repeat(40),
      ref: "refs/pull/42/merge",
      configuration: { secrets: {}, variables: {} },
    });
    await f.remote.approve(run!.id);
    expect((await repos.actions.run(f.owner.orgId, run!.id))?.approvedBy).toBe(f.owner.userId);
  });

  it("preserves an unscoped token delegation for background dispatch without detaching revocation", async () => {
    const f = await fixture();
    const saved = (await repos.actions.workflow(f.owner.orgId, f.workflow.id))!.authority;
    expect(saved.token?.scoped).toBe(false);
    const context = await resolveExecutionAuthority(saved, "background-trigger");
    expect(await captureExecutionAuthority(context)).toEqual(saved);
    await db
      .update(schema.personalAccessToken)
      .set({ revokedAt: new Date() })
      .where(eq(schema.personalAccessToken.id, saved.token!.id));
    await expect(captureExecutionAuthority(context)).rejects.toMatchObject({ statusCode: 401 });
    await expect(resolveExecutionAuthority(saved, "retry-trigger")).rejects.toMatchObject({
      statusCode: 401,
    });
  });
});
