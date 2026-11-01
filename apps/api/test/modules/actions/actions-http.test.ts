import "../jobs/_env";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { createHmac, generateKeyPairSync } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { actionOidcService } from "@repo/platform/engine/modules/actions/oidc";
import { concreteJob } from "@repo/platform/engine/modules/actions/workflow";
import { initPlatform, resetPlatform, type CommandExecutor } from "@repo/adapters";
import { generateId } from "@repo/core";
import { eq } from "@repo/db";
import {
  seedOwner,
  seedServer,
  installFakeRunner,
  db,
  schema,
  repos,
  type SeededOwner,
} from "../jobs/_harness";

const traffic = vi.hoisted(() => ({
  source: null as string | null,
  requests: [] as Array<{ url: string; method?: string; params?: Record<string, unknown> }>,
  commands: [] as string[],
  docker: false,
  emulated: false,
}));
vi.mock("@repo/platform/engine/modules/github/github.http", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/github/github.http")>()),
  ghFetchPublic: async () => {
    throw new Error("Unexpected public GitHub request in Actions HTTP fixtures");
  },
}));
vi.mock("@repo/platform/engine/modules/github/github.service", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/github/github.service")>()),
  resolveWebhookStrategy: async () => "app",
}));
vi.mock("@repo/platform/engine/modules/github/sources/index", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/github/sources/index")>()),
  createGitHubSource: async () => ({
    getConnectionStatus: async () => ({
      state: {
        primary: "gh-cli",
        sources: { openshipApp: { connected: false }, ghCli: { available: true, login: "owner" } },
      },
      accounts: [],
    }),
  }),
}));
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
      exec: async (command: string) => {
        traffic.commands.push(command);
        if (command.startsWith("uname -s"))
          return traffic.docker
            ? "Linux\nx86_64\ngit=yes\nnode=yes\ndocker=linux\ndockerArch=x86_64\n"
            : "Darwin\narm64\ngit=yes\nnode=yes\nversion=15.5\n";
        if (command.includes("--install")) {
          traffic.emulated = true;
          return "";
        }
        if (command.includes("nsenter")) return "";
        if (command.startsWith("if docker image inspect"))
          return traffic.emulated ? "aarch64\n" : "";
        if (command.startsWith("docker image inspect")) return "";
        throw new Error(`Unexpected runner command: ${command}`);
      },
    } as unknown as CommandExecutor),
}));
vi.mock("@repo/platform/engine/modules/github/github.auth", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/modules/github/github.auth")>()),
  getUserStatus: async () => ({ connected: true, id: 42, login: "owner" }),
  getInstallationToken: async () => null,
  githubFetch: async (input: {
    url: string;
    method?: string;
    params?: Record<string, unknown>;
  }) => {
    const { url, method } = input;
    traffic.requests.push(input);
    if (url === "https://api.github.com/users/contributor") return { id: 77, login: "contributor" };
    if (url.endsWith("/actions/runners/downloads")) {
      const version = "2.0.0";
      return ["linux", "osx"].flatMap((os) =>
        ["x64", "arm64"].map((architecture) => {
          const filename = `actions-runner-${os}-${architecture}-${version}.tar.gz`;
          return {
            os,
            architecture,
            filename,
            download_url: `https://github.com/actions/runner/releases/download/v${version}/${filename}`,
            sha256_checksum: "a".repeat(64),
          };
        }),
      );
    }
    if (url.endsWith("/actions/permissions")) return { enabled: true };
    if (url.endsWith("/actions/runners")) return { total_count: 0, runners: [] };
    if (url.includes("/actions/workflows/"))
      return {
        id: 42,
        path: ".github/workflows/ci.yml",
        name: "CI",
        state: "active",
        html_url: "https://github.com/acme/app/actions/workflows/ci.yml",
      };
    if (url.includes("/contents/"))
      return method === "PUT"
        ? { content: { sha: "d".repeat(40) }, commit: { sha: "c".repeat(40) } }
        : {
            sha: "b".repeat(40),
            size: (traffic.source ?? source).length,
            content: Buffer.from(traffic.source ?? source).toString("base64"),
            download_url: null,
          };
    if (url.includes("/git/matching-refs/heads/")) return [{ ref: "refs/heads/main" }];
    if (url.includes("/commits/")) return { sha: "a".repeat(40) };
    if (url.match(/\/repos\/acme\/app$/))
      return { full_name: "acme/app", default_branch: "main", private: true, id: 10 };
    throw new Error(`Unexpected GitHub fixture request ${url}`);
  },
}));
import { jobRoutes } from "../../../src/modules/jobs/job.routes";
import { actionRoutes } from "../../../src/modules/actions/action.routes";
import { actionOidcRoutes } from "../../../src/modules/actions/action-oidc.routes";
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
import { decrypt, encrypt } from "@repo/platform/engine/lib/encryption";
import { reconcileRuntimeStateAfterImport } from "../../../src/lib/database-runtime-state";
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
import { completeActionRun } from "@repo/platform/engine/modules/actions/notifications";
import { canReadNotification } from "@repo/platform/engine/lib/notification-access";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";

const app = new Hono();
// Match the connection context installed by the real API's proxy middleware.
app.use("*", (c, next) => {
  c.set("clientIp" as never, "127.0.0.1");
  return next();
});
app.onError(handleApiError);
app.route("/api/actions", actionRoutes);
app.route("/api/jobs", jobRoutes);
app.route("/api/actions/runtime", actionRuntimeRoutes);
app.route("/api/actions/oidc", actionOidcRoutes);
app.route("/twirp", actionTwirpRoutes);
app.route("/api/webhooks", webhookRoutes);
beforeAll(async () => {
  installFakeRunner();
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
  return {
    native: native.actions,
    remote: remote.actions,
    nativeJobs: native.jobs,
    remoteJobs: remote.jobs,
  };
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
    path: ".openship/workflows/ci.yml",
    ref: "main",
    source,
    runnerIds: [runner.id],
    secrets: { DEPLOY_TOKEN: "private-workflow-value" },
  };
  const workflow = await c.remote.create(input);
  return { ...c, owner, serverId, runner, workflow, input };
}

describe("Actions HTTP, native SDK and authorization", () => {
  it("issues verifiable OIDC only for an approved running job and stops after destination revocation", async () => {
    const runtimeBefore = process.env.OPENSHIP_ACTIONS_RUNTIME_URL;
    process.env.OPENSHIP_ACTIONS_RUNTIME_URL = "https://ci.example.test";
    const issuer = "https://ci.example.test/api/actions/oidc";
    try {
      const f = await fixture();
      await f.remote.update(f.workflow.id, {
        ...f.input,
        source: source.replace("jobs:", "permissions: {contents: read, id-token: write}\njobs:"),
      });
      const view = await f.remote.dispatch(f.workflow.id, { idempotencyKey: "oidc-test-attempt" });
      await f.remote.approve(view.id, { key: view.admission!.key });
      const run = (await repos.actions.run(f.owner.orgId, view.id))!;
      const lease = "oidc-test";
      await repos.actions.claimRun(f.owner.orgId, run.id, lease);
      expect(await repos.actions.activateRun(f.owner.orgId, run.id, lease)).toBe(true);
      const spec = concreteJob(run.plan.jobs[0]!, {}, {}, run.plan);
      await repos.actions.expandJobs(f.owner.orgId, run.id, lease, "test", [spec]);
      let [job] = await repos.actions.jobs(f.owner.orgId, run.id);
      expect(await repos.actions.reserveRunner(f.owner.orgId, job!.id, f.runner.id, lease)).toBe(
        true,
      );
      const environment = await actionOidcService().environment(run, job!);
      const path =
        new URL(environment.ACTIONS_ID_TOKEN_REQUEST_URL!).pathname +
        `?job=${job!.id}&audience=openship-test`;
      const init = {
        headers: { authorization: `Bearer ${environment.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      };
      expect((await app.request(path, init)).status).toBe(403); // Not executing yet.
      await repos.actions.updateJob(f.owner.orgId, job!.id, lease, { workerStartedAt: new Date() });
      const response = await app.request(path, init);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const discovery = await (
        await app.request("/api/actions/oidc/.well-known/openid-configuration")
      ).json();
      expect(discovery.issuer).toBe(issuer);
      const keys = await (await app.request("/api/actions/oidc/jwks")).json();
      const { payload } = await jwtVerify((await response.json()).value, createLocalJWKSet(keys), {
        issuer,
        audience: "openship-test",
        algorithms: ["RS256"],
      });
      expect(payload.openship_organization_id).toBe(f.owner.orgId);
      expect(payload.sub).toContain(":source:override");
      expect(payload.openship_job_id).toBe(job!.id);
      expect(JSON.stringify(keys)).not.toContain("private");
      // A committed instance import replaces its stored signing identity.
      // The old process cache must not keep issuing tokens from a removed key.
      const replacement = generateKeyPairSync("rsa", { modulusLength: 2048 });
      await db
        .update(schema.actionOidcKey)
        .set({
          kid: "restored-identity",
          publicKey: replacement.publicKey.export({ format: "jwk" }) as Record<string, string>,
          privateKeyEnc: encrypt(
            replacement.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
          ),
        })
        .where(eq(schema.actionOidcKey.id, issuer));
      await reconcileRuntimeStateAfterImport();
      const restoredKeys = await (await app.request("/api/actions/oidc/jwks")).json();
      const restoredResponse = await app.request(path, init);
      expect(restoredResponse.status).toBe(200);
      const restored = await jwtVerify(
        (await restoredResponse.json()).value,
        createLocalJWKSet(restoredKeys),
        { issuer, audience: "openship-test", algorithms: ["RS256"] },
      );
      expect(restored.protectedHeader.kid).toBe("restored-identity");
      await db
        .update(schema.actionRunner)
        .set({ enabled: false })
        .where(eq(schema.actionRunner.id, f.runner.id));
      expect((await app.request(path, init)).status).toBe(403);
      await repos.actions.requestCancel(f.owner.orgId, run.id);
      expect((await app.request(path, init)).status).toBe(403);
      await repos.actions.releaseRun(f.owner.orgId, run.id, lease);
    } finally {
      if (runtimeBefore === undefined) delete process.env.OPENSHIP_ACTIONS_RUNTIME_URL;
      else process.env.OPENSHIP_ACTIONS_RUNTIME_URL = runtimeBefore;
    }
  });
  it("reports repository Checks through both clients without dispatching or changing GitHub", async () => {
    const owner = await seedOwner();
    const c = await clients(owner);
    const start = traffic.requests.length;
    const commands = traffic.commands.length;
    for (const client of [c.remote, c.native]) {
      expect(
        await client.repositoryChecks({ owner: "acme", repo: "app", controller: "github" }),
      ).toMatchObject({
        repository: "acme/app",
        status: "connected",
        account: { login: "owner", kind: "account" },
      });
      expect(
        await client.repositoryChecks({ owner: "acme", repo: "app", controller: "openship" }),
      ).toMatchObject({
        repository: "acme/app",
        status: "app_required",
      });
    }
    expect(traffic.commands).toHaveLength(commands);
    expect(traffic.requests.slice(start)).toHaveLength(4);
    expect(
      traffic.requests.slice(start).every((request) => !request.method || request.method === "GET"),
    ).toBe(true);
    expect(await c.remote.listRuns()).toEqual([]);
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.userId, owner.userId));
    await repos.resourceGrant.upsert({
      organizationId: owner.orgId,
      userId: owner.userId,
      resourceType: "job",
      resourceId: "*",
      permissions: ["read"],
      grantedByUserId: null,
    });
    const beforeDenied = traffic.requests.length;
    for (const client of [c.remote, c.native]) {
      expect(
        await client.repositoryChecks({ owner: "acme", repo: "app", controller: "github" }),
      ).toMatchObject({ status: "access_required" });
      await expect(
        client.repositoryChecks({ owner: "../acme", repo: "app", controller: "github" }),
      ).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(traffic.requests).toHaveLength(beforeDenied);
  });
  async function channel(userId: string, verified = true) {
    const [row] = await db
      .insert(schema.notificationChannel)
      .values({
        id: generateId("nch"),
        userId,
        kind: "in_app",
        label: "Workflow results",
        verified,
      })
      .returning();
    return row!;
  }

  it("validates notification channel ownership through HTTP and native SDK and snapshots choices", async () => {
    const f = await fixture(),
      other = await fixture();
    const own = await channel(f.owner.userId),
      foreign = await channel(other.owner.userId),
      unverified = await channel(f.owner.userId, false);
    for (const client of [f.remote, f.native]) {
      await expect(
        client.update(f.workflow.id, {
          ...f.input,
          notifications: { channels: [foreign.id], events: ["failure"] },
        }),
      ).rejects.toThrow("Notification channel not found");
      await expect(
        client.update(f.workflow.id, {
          ...f.input,
          notifications: { channels: [unverified.id], events: ["failure"] },
        }),
      ).rejects.toThrow("Verify and enable");
    }
    const notifications = { channels: [own.id], events: ["failure"] as const };
    const saved = await f.remote.update(f.workflow.id, {
      ...f.input,
      notifications: { ...notifications, events: [...notifications.events] },
    });
    expect(saved.notifications).toEqual(notifications);
    const run = await f.remote.dispatch(f.workflow.id, { idempotencyKey: "notification-snapshot" });
    await f.native.update(f.workflow.id, { ...f.input, notifications: null });
    expect((await repos.actions.run(f.owner.orgId, run.id))!.configuration.notifications).toEqual(
      notifications,
    );
    expect((await f.remote.get(f.workflow.id)).notifications).toBeNull();
  });

  it("queues one durable result per channel across retries and overlapping workflow and Job rules", async () => {
    const f = await fixture();
    const own = await channel(f.owner.userId);
    await f.remote.update(f.workflow.id, {
      ...f.input,
      notifications: { channels: [own.id], events: ["failure"] },
    });
    const view = await f.remote.dispatch(f.workflow.id, { idempotencyKey: "notification-once" });
    const original = (await repos.actions.run(f.owner.orgId, view.id))!;
    const [run] = await db
      .update(schema.actionRun)
      .set({
        status: "timed_out",
        finishedAt: new Date(),
        error: "private-runtime-output",
        configuration: {
          ...original.configuration,
          sourceJob: {
            key: "scheduled-ci",
            label: "Nightly CI",
            trigger: "schedule",
            notifyConfig: { channels: [own.id], states: ["failed"] },
          },
        },
      })
      .where(eq(schema.actionRun.id, view.id))
      .returning();
    const lookup = vi.spyOn(repos.notificationChannel, "findById");
    lookup.mockRejectedValueOnce(new Error("Transient queue lookup failure"));
    await expect(completeActionRun(run!)).rejects.toThrow("Transient queue lookup failure");
    lookup.mockRestore();
    await completeActionRun(run!);
    await completeActionRun(run!);
    const deliveries = await repos.notificationDelivery.listForUser(f.owner.userId, f.owner.orgId);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      category: "action.run.failed",
      status: "queued",
      payload: { durable: true, resourceType: "action_run", runId: run!.id },
    });
    expect(JSON.stringify(deliveries)).not.toContain("private-runtime-output");
    expect(JSON.stringify(deliveries)).not.toContain("private-workflow-value");
    expect(
      await canReadNotification(
        buildBackgroundContext({
          userId: f.owner.userId,
          organizationId: f.owner.orgId,
          role: "restricted",
          label: "test",
        }),
        deliveries[0]!,
      ),
    ).toBe(true);
    const other = await fixture();
    expect(
      await canReadNotification(
        buildBackgroundContext({
          userId: other.owner.userId,
          organizationId: other.owner.orgId,
          role: "restricted",
          label: "test",
        }),
        deliveries[0]!,
      ),
    ).toBe(false);
  });

  it("filters result choices and rechecks disabled channels and revoked organization access", async () => {
    const f = await fixture(),
      other = await fixture();
    const own = await channel(f.owner.userId),
      foreign = await channel(other.owner.userId);
    await f.remote.update(f.workflow.id, {
      ...f.input,
      notifications: { channels: [own.id], events: ["failure"] },
    });
    const view = await f.remote.dispatch(f.workflow.id, { idempotencyKey: "notification-filter" });
    const run = (await repos.actions.run(f.owner.orgId, view.id))!;
    await completeActionRun({ ...run, status: "success", finishedAt: new Date() });
    expect(
      await repos.notificationDelivery.listForUser(f.owner.userId, f.owner.orgId),
    ).toHaveLength(0);
    await db
      .update(schema.notificationChannel)
      .set({ enabled: false })
      .where(eq(schema.notificationChannel.id, own.id));
    await completeActionRun({
      ...run,
      status: "failure",
      finishedAt: new Date(),
      configuration: {
        ...run.configuration,
        notifications: { channels: [own.id, foreign.id], events: ["failure"] },
      },
    });
    expect(
      await repos.notificationDelivery.listForUser(f.owner.userId, f.owner.orgId),
    ).toHaveLength(0);
    expect(
      await repos.notificationDelivery.listForUser(other.owner.userId, f.owner.orgId),
    ).toHaveLength(0);
  });

  it("imports repository files through HTTP and native SDK with stable identities", async () => {
    const f = await fixture();
    const workflows = ["build", "test"].map((name) => ({
      ...f.input,
      name,
      path: `.openship/workflows/${name}.yml`,
    }));
    const first = await f.remote.importWorkflows({ workflows });
    const again = await f.native.importWorkflows({ workflows });
    expect(first.map((row) => row.id)).toEqual(again.map((row) => row.id));
    expect(first.map((row) => row.name)).toEqual(["build", "test"]);
    expect(await f.remote.list()).toHaveLength(3);
    await f.remote.update(first[0]!.id, { ...workflows[0]!, name: "Kept name", enabled: false });
    const replay = await f.remote.importWorkflows({ workflows });
    expect(replay[0]).toMatchObject({ name: "Kept name", enabled: false });
    expect(replay[0]).not.toHaveProperty("secrets");
  });

  it("does not save any file when another selected file is invalid or unauthorized", async () => {
    const f = await fixture(),
      other = await fixture();
    const first = { ...f.input, path: ".openship/workflows/build.yml" };
    await expect(
      f.remote.importWorkflows({
        workflows: [
          first,
          {
            ...f.input,
            path: ".openship/workflows/invalid.yml",
            source: "jobs: [not a workflow",
          },
        ],
      }),
    ).rejects.toThrow();
    await expect(
      f.remote.importWorkflows({
        workflows: [
          first,
          {
            ...f.input,
            path: ".openship/workflows/other.yml",
            runnerIds: [other.runner.id],
          },
        ],
      }),
    ).rejects.toThrow();
    expect(await f.remote.list()).toHaveLength(1);
    expect(await other.remote.list()).toHaveLength(1);
    await expect(f.remote.importWorkflows({ workflows: [first, first] })).rejects.toThrow(
      "only once",
    );
  });

  const repositoryPath = ".github/workflows/ci.yml";
  const reusableSource =
    "name: CI\non: [push, workflow_dispatch]\njobs:\n  gate:\n    uses: ./.github/workflows/shared.yml\n    secrets: inherit\n  release:\n    needs: gate\n    runs-on: [self-hosted, openship, macos]\n    environment: production\n    permissions:\n      contents: write\n      id-token: write\n    steps:\n      - run: echo release\n";

  it("automatically previews and links reusable repository workflows through HTTP and the native SDK", async () => {
    const f = await fixture();
    const input = { ...f.input, path: repositoryPath, source: null, secrets: {} };
    traffic.source = reusableSource;
    try {
      let linked: string | undefined;
      for (const client of [f.native, f.remote]) {
        const preview = await client.preview({ source: reusableSource, path: repositoryPath });
        expect(preview.jobs[0]?.uses).toBe("./.github/workflows/shared.yml");
        const read = await client.repositorySource({
          owner: "acme",
          repo: "app",
          ref: "main",
          path: repositoryPath,
        });
        expect(read.error).toBeNull();
        expect(read.plan?.jobs[0]?.uses).toBe("./.github/workflows/shared.yml");
        const approved = input; // Secure access defaults replace a blanket consent checkbox.
        const created = linked
          ? await client.update(linked, approved)
          : await client.create(approved);
        linked = created.id;
        expect(created).toMatchObject({
          controller: "github",
          githubWorkflowId: "42",
          source: null,
          accessPolicy: { audience: "owner", approval: "required", forks: "deny" },
        });
        expect(
          (await repos.actions.workflow(f.owner.orgId, created.id))?.definition.jobs[0]?.uses,
        ).toBe("./.github/workflows/shared.yml");
      }
      const before = traffic.requests.length;
      await f.remote.updateRepositorySource({
        owner: "acme",
        repo: "app",
        ref: "main",
        path: repositoryPath,
        sha: "b".repeat(40),
        source: reusableSource,
      });
      expect(
        traffic.requests.slice(before).filter((request) => request.method === "PUT"),
      ).toHaveLength(1);
      await expect(
        f.native.preview({ source: reusableSource, path: f.input.path }),
      ).rejects.toThrow("requires a repository workflow");
    } finally {
      traffic.source = null;
    }
  });

  it("replaces stale controller metadata with secure access defaults and preserves tenant authorization", async () => {
    const f = await fixture();
    await db
      .update(schema.actionWorkflow)
      .set({ path: repositoryPath })
      .where(eq(schema.actionWorkflow.id, f.workflow.id));
    const input = { ...f.input, path: repositoryPath, source: null, secrets: {} };
    traffic.source = reusableSource;
    try {
      expect(await f.remote.update(f.workflow.id, input)).toMatchObject({
        controller: "github",
        accessPolicy: { audience: "owner", approval: "required", forks: "deny" },
      });
      const other = await clients(await seedOwner());
      await expect(
        other.remote.create({ ...input, repositoryRunnerConsent: true }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(
        await f.remote.update(f.workflow.id, { ...input, repositoryRunnerConsent: true }),
      ).toMatchObject({ controller: "github", source: null, secretNames: [] });
    } finally {
      traffic.source = null;
    }
  });

  it("does not change scheduling authority while a workflow run still owns its execution", async () => {
    const f = await fixture();
    const run = await f.remote.dispatch(f.workflow.id, {
      idempotencyKey: "before-repository-link",
    });
    await expect(
      f.remote.update(f.workflow.id, {
        ...f.input,
        path: repositoryPath,
        source: null,
        secrets: {},
        repositoryRunnerConsent: true,
      }),
    ).rejects.toMatchObject({ code: "ACTIONS_CONTROLLER_BUSY" });
    expect((await repos.actions.run(f.owner.orgId, run.id))?.controller).toBe("openship");
    expect((await repos.actions.workflow(f.owner.orgId, f.workflow.id))?.controller).toBe(
      "openship",
    );
  });

  it("passes the production route scanner and rejects anonymous API and runtime requests", async () => {
    expect(scanRoutes(app).errors).toEqual([]);
    for (const path of [
      "/api/actions/workflows",
      "/api/actions/runners",
      "/api/actions/runs",
      "/api/actions/oidc/token?job=other",
      "/api/actions/repository-checks?owner=acme&repo=app&controller=github",
    ])
      expect((await app.request(path)).status).toBe(401);
    for (const path of [
      "/api/actions/runners/emulation",
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

  it("enables verified CPU emulation through both clients only with administration of the selected server", async () => {
    const f = await fixture();
    const other = await seedOwner();
    const otherClients = await clients(other);
    traffic.docker = true;
    traffic.emulated = false;
    try {
      for (const client of [otherClients.native, otherClients.remote]) {
        const count = traffic.commands.length;
        await expect(client.enableEmulation({ serverId: f.serverId })).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
        expect(traffic.commands).toHaveLength(count);
      }
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
      for (const client of [f.native, f.remote]) {
        const count = traffic.commands.length;
        await expect(client.enableEmulation({ serverId: f.serverId })).rejects.toMatchObject({
          code: "NOT_FOUND",
        });
        expect(traffic.commands).toHaveLength(count);
      }
      await repos.resourceGrant.upsert({
        organizationId: f.owner.orgId,
        userId: f.owner.userId,
        resourceType: "server",
        resourceId: f.serverId,
        permissions: ["admin"],
        grantedByUserId: null,
      });
      const start = traffic.commands.length;
      for (const client of [f.native, f.remote])
        expect(await client.enableEmulation({ serverId: f.serverId })).toMatchObject({
          dockerArchitecture: "x64",
          dockerPlatforms: ["linux/amd64", "linux/arm64"],
        });
      expect(
        traffic.commands.slice(start).filter((command) => command.includes("--install")),
      ).toHaveLength(1);
      expect(
        (await repos.actions.runner(f.owner.orgId, f.runner.id))?.capabilities?.dockerPlatforms,
      ).toEqual(["linux/amd64", "linux/arm64"]);
    } finally {
      traffic.docker = false;
      traffic.emulated = false;
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
    await db.insert(schema.actionJob).values({
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
    ).toBe("waiting");
  });

  it("shows approval only to administrators of both Actions and its destinations", async () => {
    const f = await fixture();
    const run = await f.remote.dispatch(f.workflow.id, { idempotencyKey: "approval-permissions" });
    expect(run.canApprove).toBe(true);
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.userId, f.owner.userId));
    for (const [resourceType, resourceId] of [
      ["job", "*"],
      ["github_repository", "acme/app"],
      ["server", f.serverId],
    ] as const) {
      await repos.resourceGrant.upsert({
        organizationId: f.owner.orgId,
        userId: f.owner.userId,
        resourceType,
        resourceId,
        permissions: ["read"],
        grantedByUserId: null,
      });
    }
    for (const client of [f.native, f.remote]) {
      expect((await client.getRun(run.id)).canApprove).toBe(false);
      await expect(client.approve(run.id, { key: run.admission!.key })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    await repos.resourceGrant.upsert({
      organizationId: f.owner.orgId,
      userId: f.owner.userId,
      resourceType: "job",
      resourceId: "*",
      permissions: ["admin"],
      grantedByUserId: null,
    });
    expect((await f.remote.getRun(run.id)).canApprove).toBe(false);
    await repos.resourceGrant.upsert({
      organizationId: f.owner.orgId,
      userId: f.owner.userId,
      resourceType: "server",
      resourceId: f.serverId,
      permissions: ["admin"],
      grantedByUserId: null,
    });
    expect((await f.native.getRun(run.id)).canApprove).toBe(true);
    expect((await f.remote.approve(run.id, { key: run.admission!.key })).canApprove).toBe(false);
  });

  it("requires review keys for new policies while keeping legacy fork approval compatible", async () => {
    const f = await fixture();
    const run = await f.remote.dispatch(f.workflow.id, { idempotencyKey: "legacy-fork-approval" });
    await expect(f.remote.approve(run.id)).rejects.toMatchObject({
      code: "ACTIONS_ACCESS_CHANGED",
    });
    await db
      .update(schema.actionWorkflow)
      .set({ accessPolicy: null })
      .where(eq(schema.actionWorkflow.id, f.workflow.id));
    await db
      .update(schema.actionRun)
      .set({ admission: null, untrusted: true, status: "waiting" })
      .where(eq(schema.actionRun.id, run.id));
    const approved = await f.remote.approve(run.id);
    expect(approved.approvedAt).toBeTruthy();
    expect(approved.canApprove).toBe(false);
    expect(approved.admission).toBeNull();
    expect((await f.native.approve(run.id)).approvedAt).toEqual(approved.approvedAt);
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
        path: ".openship/workflows/ci.yml",
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
    await db.insert(schema.gitInstallation).values({
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

  it.each([{ id: 99, login: "outsider" }, null])(
    "never borrows the workflow owner's identity for a signed check re-run (%j)",
    async (sender) => {
      const f = await fixture();
      const installationId = 912347;
      await db.insert(schema.gitInstallation).values({
        id: generateId("git"),
        userId: f.owner.userId,
        organizationId: f.owner.orgId,
        owner: "acme",
        installationId,
      });
      const original = await f.remote.dispatch(f.workflow.id, {
        idempotencyKey: "original-checked-run",
      });
      await db
        .update(schema.actionRun)
        .set({ status: "failure", finishedAt: new Date() })
        .where(eq(schema.actionRun.id, original.id));
      await db.insert(schema.actionJob).values({
        id: generateId("job"),
        organizationId: f.owner.orgId,
        runId: original.id,
        jobKey: "test",
        matrixIndex: 0,
        checkRunId: "456",
        status: "failure",
        finishedAt: new Date(),
      });
      const body = JSON.stringify({
        installation: { id: installationId },
        repository: { full_name: "acme/app" },
        action: "rerequested",
        sender,
        check_run: { id: 456 },
      });
      const response = await app.request("/api/webhooks/github", {
        method: "POST",
        body,
        headers: {
          "content-type": "application/json",
          "x-github-event": "check_run",
          "x-github-delivery": generateId("github"),
          "x-hub-signature-256": `sha256=${createHmac("sha256", "actions-app-webhook-test-secret").update(body).digest("hex")}`,
        },
      });
      expect(response.status).toBe(200);
      await actionWebhookInbox.tick(new Date(Date.now() + 1));
      const runs = await repos.actions.runs(f.owner.orgId);
      expect(runs).toHaveLength(2);
      const rerun = runs.find((row) => row.id !== original.id)!;
      expect(rerun).toMatchObject({
        attempt: 2,
        admission: {
          state: "blocked",
          reason: sender ? "actor_not_allowed" : "identity_unavailable",
        },
        approvedAt: null,
      });
      expect(rerun.configuration.triggeringActorIdentity).toEqual(
        sender ? { provider: "github", id: "99", login: "outsider" } : null,
      );
      await expect(f.remote.approve(rerun.id, { key: rerun.admission!.key })).rejects.toThrow();
    },
  );

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
    await db.insert(schema.gitInstallation).values({
      id: generateId("git"),
      userId: f.owner.userId,
      organizationId: f.owner.orgId,
      owner: "acme",
      installationId,
    });
    await f.remote.update(f.workflow.id, {
      ...f.input,
      runnerIds: [cloud.id],
      accessPolicy: {
        audience: "selected",
        users: ["contributor"],
        approval: "automatic",
        forks: "review",
      },
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
      sender: { id: 77, login: "contributor" },
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
    await expect(f.remote.approve(run!.id)).rejects.toMatchObject({
      code: "ACTIONS_ACCESS_CHANGED",
    });
    expect((await f.remote.getRun(run!.id)).admission).toMatchObject({
      state: "approval_required",
      key: run!.admission!.key,
    });
    await f.native.approve(run!.id, { key: run!.admission!.key });
    await f.remote.approve(run!.id, { key: run!.admission!.key });
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

async function projectFor(owner: SeededOwner) {
  const groupId = generateId("app"),
    id = generateId("proj");
  await db
    .insert(schema.projectGroup)
    .values({ id: groupId, organizationId: owner.orgId, name: "App", slug: groupId });
  await db.insert(schema.project).values({
    id,
    groupId,
    organizationId: owner.orgId,
    name: "App",
    slug: id,
    gitOwner: "acme",
    gitRepo: "app",
    gitBranch: "main",
    gitUrl: "https://github.com/acme/app.git",
  });
  return id;
}

describe("Actions project, repository and Jobs integration", () => {
  it("runs standalone YAML with validated manual inputs and authenticated webhooks without requesting GitHub", async () => {
    const f = await fixture();
    const before = traffic.requests.length;
    const workflow = await f.remote.create({
      ...f.input,
      owner: null,
      repo: null,
      path: ".openship/workflows/automation.yml",
      source: source.replace(
        "on: workflow_dispatch",
        "on:\n  workflow_dispatch:\n    inputs:\n      version:\n        type: string\n        required: true\n  repository_dispatch:\n    types: [release]",
      ),
    });
    await expect(
      f.remote.dispatch(workflow.id, { idempotencyKey: "missing-input" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    const run = await f.remote.dispatch(workflow.id, {
      inputs: { version: "v1" },
      idempotencyKey: "standalone-once",
    });
    expect(run).toMatchObject({
      owner: null,
      repo: null,
      status: "waiting",
      admission: { state: "approval_required" },
    });
    expect(run.revision).toMatch(/^[a-f0-9]{64}$/);
    const webhook = await f.remote.dispatch(workflow.id, {
      eventType: "release",
      clientPayload: { version: "v2" },
      idempotencyKey: "release-id",
    });
    expect(
      (
        await f.remote.dispatch(workflow.id, {
          eventType: "release",
          clientPayload: { version: "v2" },
          idempotencyKey: "release-id",
        })
      ).id,
    ).toBe(webhook.id);
    expect((await repos.actions.run(f.owner.orgId, webhook.id))?.event).toMatchObject({
      action: "release",
      client_payload: { version: "v2" },
    });
    await expect(
      f.remote.dispatch(workflow.id, { eventType: "unknown", idempotencyKey: "wrong-event" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await expect(
      f.remote.dispatch(workflow.id, {
        ref: "other",
        inputs: { version: "v1" },
        idempotencyKey: "no-branch",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(traffic.requests).toHaveLength(before);
    expect(
      (
        await app.request(`/api/actions/workflows/${workflow.id}/dispatch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ eventType: "release", idempotencyKey: "anonymous-event" }),
        })
      ).status,
    ).toBe(401);
    await expect(
      f.remote.create({
        ...f.input,
        owner: null,
        repo: null,
        source: source.replace("on: workflow_dispatch", "on: push"),
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("reuses a workflow across projects and conceals foreign project links", async () => {
    const f = await fixture(),
      other = await seedOwner();
    const first = await projectFor(f.owner),
      second = await projectFor(f.owner),
      foreign = await projectFor(other);
    await f.remote.update(f.workflow.id, { ...f.input, projectIds: [first, second] });
    expect((await f.native.list({ projectId: first })).map((w) => w.id)).toEqual([f.workflow.id]);
    expect((await f.remote.get(f.workflow.id)).projectIds?.sort()).toEqual([first, second].sort());
    expect((await f.remote.projectPolicy({ projectId: first })).mode).toBe("manual");
    await expect(
      f.remote.update(f.workflow.id, { ...f.input, projectIds: [foreign] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const otherClient = await clients(other);
    await expect(otherClient.remote.list({ projectId: first })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      otherClient.remote.updateProjectPolicy({
        projectId: first,
        mode: "manual",
        workflowIds: [],
        requiredWorkflowIds: [],
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("validates required push checks and changes deployment policy atomically", async () => {
    const f = await fixture(),
      projectId = await projectFor(f.owner);
    await db.insert(schema.gitInstallation).values({
      id: generateId("git"),
      userId: f.owner.userId,
      organizationId: f.owner.orgId,
      owner: "acme",
      installationId: 912399,
    });
    const policy = {
      projectId,
      mode: "actions" as const,
      workflowIds: [f.workflow.id],
      requiredWorkflowIds: [f.workflow.id],
    };
    await expect(f.remote.updateProjectPolicy(policy)).rejects.toMatchObject({ statusCode: 400 });
    expect((await repos.project.findById(projectId))?.autoDeploy).toBe(false);
    await f.remote.update(f.workflow.id, {
      ...f.input,
      source: source.replace("on: workflow_dispatch", "on:\n  push:\n    paths: [src/**]"),
    });
    await expect(f.remote.updateProjectPolicy(policy)).rejects.toMatchObject({ statusCode: 400 });
    await f.remote.update(f.workflow.id, {
      ...f.input,
      source: source.replace("on: workflow_dispatch", "on: [push, workflow_dispatch]"),
    });
    expect(await f.remote.updateProjectPolicy(policy)).toMatchObject({
      project: { id: projectId },
      mode: policy.mode,
      workflowIds: policy.workflowIds,
      requiredWorkflowIds: policy.requiredWorkflowIds,
    });
    expect((await repos.project.findById(projectId))?.autoDeploy).toBe(true);
    await expect(
      f.remote.update(f.workflow.id, { ...f.input, projectIds: [] }),
    ).rejects.toMatchObject({ code: "ACTIONS_WORKFLOW_REQUIRED" });
    expect(
      await f.remote.updateProjectPolicy({ ...policy, mode: "manual", requiredWorkflowIds: [] }),
    ).toMatchObject({ mode: "manual", requiredWorkflowIds: [] });
  });

  it("keeps reviewed YAML unchanged across repository updates and follows new code only in automatic mode", async () => {
    const f = await fixture();
    const incoming = source.replace("echo done", "echo repository-v2");
    try {
      traffic.source = incoming;
      const repository = await f.remote.repositorySource({
        owner: "acme",
        repo: "app",
        path: f.input.path,
        ref: "main",
      });
      expect(repository.source).toBe(incoming);
      const approved = await f.remote.dispatch(f.workflow.id, { idempotencyKey: "reviewed-v1" });
      expect((await repos.actions.run(f.owner.orgId, approved.id))?.source).toBe(source);
      await f.remote.update(f.workflow.id, { ...f.input, source: incoming });
      const reviewed = await f.remote.dispatch(f.workflow.id, { idempotencyKey: "reviewed-v2" });
      expect((await repos.actions.run(f.owner.orgId, reviewed.id))?.source).toBe(incoming);
      traffic.source = source.replace("echo done", "echo repository-v3");
      const stillReviewed = await f.remote.dispatch(f.workflow.id, {
        idempotencyKey: "still-reviewed-v2",
      });
      expect((await repos.actions.run(f.owner.orgId, stillReviewed.id))?.source).toBe(incoming);
      await f.remote.update(f.workflow.id, { ...f.input, source: null });
      const automatic = await f.remote.dispatch(f.workflow.id, { idempotencyKey: "automatic-v3" });
      expect((await repos.actions.run(f.owner.orgId, automatic.id))?.source).toBe(traffic.source);
      expect((await repos.actions.run(f.owner.orgId, approved.id))?.source).toBe(source);
    } finally {
      traffic.source = null;
    }
  });

  it("edits a repository file with its expected SHA and requires repository write permission", async () => {
    const f = await fixture();
    const input = { owner: "acme", repo: "app", ref: "main", path: f.workflow.path };
    const read = await f.remote.repositorySource(input);
    expect(read).toMatchObject({ source, sha: "b".repeat(40), error: null });
    await f.remote.updateRepositorySource({ ...input, sha: read.sha, source });
    expect(traffic.requests.at(-1)).toMatchObject({
      method: "PUT",
      params: { sha: read.sha, branch: "main", content: Buffer.from(source).toString("base64") },
    });
    const count = traffic.requests.length;
    await expect(
      f.remote.updateRepositorySource({ ...input, sha: read.sha, source: "not yaml workflow" }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(traffic.requests).toHaveLength(count);
    await db
      .update(schema.member)
      .set({ role: "restricted" })
      .where(eq(schema.member.userId, f.owner.userId));
    for (const [resourceType, resourceId, permissions] of [
      ["job", "*", ["admin"]],
      ["github_repository", "acme/app", ["read"]],
    ] as const)
      await repos.resourceGrant.upsert({
        organizationId: f.owner.orgId,
        userId: f.owner.userId,
        resourceType,
        resourceId,
        permissions: [...permissions],
        grantedByUserId: null,
      });
    await expect(
      f.remote.updateRepositorySource({ ...input, sha: read.sha, source }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("retries a partial Jobs handoff without duplicating a previously accepted dependent", async () => {
    const f = await fixture();
    const parent = await f.remoteJobs.create({
      label: "CI",
      workflowId: f.workflow.id,
      scheduleType: "manual",
    });
    const first = await f.remoteJobs.create({
      label: "Publish",
      workflowId: f.workflow.id,
      scheduleType: "manual",
      dependsOn: [parent.key],
    });
    const second = await f.remoteJobs.create({
      label: "Notify",
      workflowId: f.workflow.id,
      scheduleType: "manual",
      dependsOn: [parent.key],
    });
    const started = await f.remoteJobs.run(parent.key);
    await db
      .update(schema.actionRun)
      .set({ status: "success", finishedAt: new Date() })
      .where(eq(schema.actionRun.id, started.runId!));
    const run = (await repos.actions.run(f.owner.orgId, started.runId!))!;
    const { workflowJobCompleted } =
      await import("@repo/platform/engine/modules/jobs/job-workflow");
    const createRun = repos.actions.createRun;
    let unavailable = true;
    const spy = vi.spyOn(repos.actions, "createRun").mockImplementation(async (input) => {
      if (input.configuration.sourceJob?.key === second.key && unavailable) {
        unavailable = false;
        throw new Error("Temporary admission outage");
      }
      return createRun(input);
    });
    try {
      await expect(workflowJobCompleted(run)).rejects.toThrow("Temporary admission outage");
      await workflowJobCompleted(run);
      await workflowJobCompleted(run);
      expect(await f.remoteJobs.listRuns(first.key)).toHaveLength(1);
      expect(await f.remoteJobs.listRuns(second.key)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("runs a scheduled workflow through Jobs and exposes the same Actions execution history", async () => {
    const f = await fixture();
    const job = await f.remoteJobs.create({
      label: "Scheduled CI",
      workflowId: f.workflow.id,
      scheduleType: "manual",
    });
    expect(job.actionConfig).toEqual({ workflowId: f.workflow.id, inputs: {} });
    const started = await f.remoteJobs.run(job.key);
    const run = await f.native.getRun(started.runId!);
    expect(run.workflowId).toBe(f.workflow.id);
    expect(await repos.jobRun.findById(run.id)).toBeUndefined();
    expect(await f.remoteJobs.getRun(run.id)).toMatchObject({
      id: run.id,
      kind: "workflow",
      status: "running",
    });
    expect((await f.nativeJobs.listRuns(job.key)).map((r) => r.id)).toEqual([run.id]);
    await db
      .update(schema.actionRun)
      .set({ status: "success", finishedAt: new Date() })
      .where(eq(schema.actionRun.id, run.id));
    expect((await f.remoteJobs.get(job.key)).lastRun).toMatchObject({
      id: run.id,
      status: "success",
    });
    const foreign = await clients(await seedOwner());
    expect((await foreign.remoteJobs.list()).some((row) => row.key === job.key)).toBe(false);
    await expect(foreign.remoteJobs.run(job.key)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(foreign.remoteJobs.getRun(run.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(f.remoteJobs.update(job.key, { command: "echo bypass" })).rejects.toMatchObject({
      statusCode: 400,
    });
    await expect(
      f.remoteJobs.create({
        label: "Mixed action",
        workflowId: f.workflow.id,
        command: "echo unexpected",
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    // Execution delegation stays revocable after the schedule is saved.
    const stored = (await repos.actions.workflow(f.owner.orgId, f.workflow.id))!;
    await db
      .update(schema.personalAccessToken)
      .set({ revokedAt: new Date() })
      .where(eq(schema.personalAccessToken.id, stored.authority.token!.id));
    await expect(
      (await import("@repo/platform/engine/modules/jobs/job-workflow")).startWorkflowJob(
        (await repos.job.findByKey(job.key))!,
        "schedule",
      ),
    ).rejects.toMatchObject({ statusCode: 401 });
  });
});
