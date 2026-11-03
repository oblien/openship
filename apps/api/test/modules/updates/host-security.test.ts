import { beforeEach, describe, expect, it, vi } from "vitest";
import { repos, seedOwner, seedServer, db, schema } from "../jobs/_harness";
import { eq } from "drizzle-orm";
import { createProvisionLock } from "@repo/platform/engine/lib/provision-lock";
import { jobRunBus, type JobRunEvent } from "@repo/platform/engine/modules/jobs/job-run.sse";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { env } from "@repo/platform/engine/config/env";
import * as hostControl from "@repo/platform/engine/lib/host-control";
import {
  planHostPatch,
  applyHostPatch,
  inspectHostSecurity,
  serverSecurityStatus,
  hostPatchRuns,
  hostPatchRunEvents,
  decodeHostPatchToken,
  recoverHostPatchRuns,
} from "@repo/platform/engine/modules/updates/host-security";
import type { AdvisoryFeedState } from "@repo/platform/engine/modules/updates/advisory-feed";
import type { SecurityAdvisory } from "@repo/core";
import { Hono } from "hono";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { serverResourceRoutes } from "../../../src/modules/system/server-resource.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { healthRoutes } from "../../../src/modules/health/health.routes";
import { scanSecurityAdvisories } from "@repo/platform/engine/modules/updates/security.service";
const h = vi.hoisted(() => ({
  feed: null as unknown,
  exec: vi.fn(),
  stream: vi.fn(),
  checks: vi.fn(),
  patched: false,
  work: [] as (() => Promise<unknown>)[],
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<object>()),
  checkComponents: h.checks,
}));
vi.mock("@repo/platform/engine/modules/updates/advisory-feed", () => ({
  getAdvisoryFeed: async () => h.feed,
}));
vi.mock("@repo/platform/engine/lib/server-execution", () => ({
  withServerExecution: async (_org: string, _id: string, fn: (e: unknown) => unknown) =>
    fn({ exec: h.exec, streamExec: h.stream }),
}));
vi.mock("@repo/platform/engine/lib/background-work", async (original) => ({
  ...(await original<object>()),
  deferBackgroundWork: (fn: () => Promise<unknown>) => {
    h.work.push(fn);
    return Promise.resolve();
  },
}));
const advisory: SecurityAdvisory = {
  id: "HOST-TEST",
  revision: 1,
  title: "Update OpenSSL",
  message: "Fixture only",
  severity: "high",
  publishedAt: "2026-01-01T00:00:00Z",
  url: "https://ubuntu.com/security",
  action: "patch-host",
  modes: ["selfhosted"],
  targets: [
    {
      kind: "host-package",
      distribution: "ubuntu",
      release: "24.04",
      package: "openssl",
      fixedVersion: "3.0.13-0ubuntu3.5",
    },
  ],
};
const observed = {
  distribution: "ubuntu",
  release: "24.04",
  bootId: "boot-a",
  kernel: "6.8.0-1-generic",
  rebootRequired: false,
  rows: [
    {
      key: "HOST-TEST:0",
      package: "openssl",
      installed: "3.0.13-0ubuntu3.4",
      candidate: "3.0.13-0ubuntu3.5",
      state: "affected",
      canPatch: true,
      runningVersion: null,
    },
  ],
};
const fixed = () => ({
  ...observed,
  rows: [
    {
      ...observed.rows[0],
      state: "fixed",
      installed: "3.0.13-0ubuntu3.5",
      candidate: null,
      canPatch: false,
    },
  ],
});
const planned = {
  observation: observed,
  changes: [{ package: "openssl", previous: "3.0.13-0ubuntu3.4", version: "3.0.13-0ubuntu3.5" }],
};
const encode = (v: unknown) => `OPENSHIP_HOST_SECURITY=${JSON.stringify(v)}\n`;
function feed(): AdvisoryFeedState {
  return {
    security: {
      format: 1,
      revision: 1,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
      advisories: [structuredClone(advisory)],
    },
    release: { latest: null, manifest: null },
    stale: false,
    checkedAt: null,
    nextCheckAt: null,
    error: null,
  };
}
async function fixture() {
  const owner = await seedOwner();
  const id = await seedServer(owner.orgId);
  const ctx = buildBackgroundContext({ userId: owner.userId, organizationId: owner.orgId });
  return { owner, id, ctx };
}
beforeEach(() => {
  vi.restoreAllMocks();
  h.feed = feed();
  h.work = [];
  h.patched = false;
  h.checks.mockReset().mockImplementation(async (_executor, names: string[]) =>
    names.map((name) => ({
      name,
      label: name,
      installed: true,
      healthy: true,
      message: name + " is healthy",
    })),
  );
  h.exec.mockReset().mockImplementation(async (cmd: string) => {
    // Decode only the generated base64 argument, never execute a host command in these tests.
    const args = JSON.parse(
      Buffer.from(cmd.match(/'([A-Za-z0-9+/=]+)'(?:; fi)?$/)![1], "base64").toString(),
    );
    return encode(args.mode.startsWith("plan") ? planned : h.patched ? fixed() : observed);
  });
  h.stream.mockReset().mockImplementation(async (_command, onLog) => {
    onLog({ timestamp: new Date().toISOString(), message: "Installing openssl", level: "info" });
    h.patched = true;
    return { code: 0, output: encode(fixed()) };
  });
});
describe("server advisory maintenance", () => {
  it("keeps history and saved logs readable when execution is unavailable, with server isolation", async () => {
    const f = await fixture(),
      foreign = await fixture();
    const run = await repos.jobRun.start({
      jobId: `security:patch:${f.id}`,
      serverId: f.id,
      serverIds: [f.id],
      kind: "custom",
    });
    await repos.jobRun.finish(run.id, {
      status: "failed",
      output: "Saved diagnostic output",
      summary: { phase: "needs_review" },
    });
    await db.update(schema.servers).set({ isLocal: true }).where(eq(schema.servers.id, f.id));
    vi.spyOn(hostControl, "resolveHostControlEnabled").mockResolvedValue(false);
    await repos.securityAdvisory.setChecksEnabled(foreign.owner.orgId, false);
    expect((await serverSecurityStatus(f.ctx, f.id)).supported).toBe(false);
    expect(await hostPatchRuns(f.ctx, f.id)).toEqual([
      expect.objectContaining({ id: run.id, output: "Saved diagnostic output" }),
    ]);
    const events = [];
    for await (const event of await hostPatchRunEvents(f.ctx, f.id, run.id))
      events.push(JSON.parse(event.data));
    expect(events.map((event) => event.type)).toEqual(["snapshot", "complete"]);
    expect(events[0].run.output).toBe("Saved diagnostic output");
    await expect(hostPatchRuns(foreign.ctx, f.id)).rejects.toThrow();
    await expect(hostPatchRunEvents(foreign.ctx, f.id, run.id)).rejects.toThrow();
    await expect(hostPatchRunEvents(f.ctx, foreign.id, run.id)).rejects.toThrow();
    await expect(planHostPatch(f.ctx, f.id, { advisoryId: advisory.id })).rejects.toThrow(
      /Host control is disabled/,
    );
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.stream).not.toHaveBeenCalled();
    await repos.securityAdvisory.setChecksEnabled(f.owner.orgId, false);
  });
  it("expires interrupted patch and reboot records without issuing commands, even with checks disabled", async () => {
    const f = await fixture();
    await repos.securityAdvisory.setChecksEnabled(f.owner.orgId, false);
    for (const phase of ["installing", "rebooting"]) {
      const run = await repos.jobRun.start({
        jobId: `security:patch:${f.id}`,
        serverId: f.id,
        kind: "custom",
      });
      await repos.jobRun.progress(
        run.id,
        { phase, ...(phase === "rebooting" ? { resumePolicy: "verify" } : {}) },
        "saved before interruption",
      );
      await db
        .update(schema.jobRun)
        .set({ startedAt: new Date(Date.now() - 31 * 60_000) })
        .where(eq(schema.jobRun.id, run.id));
      await recoverHostPatchRuns();
      expect(await repos.jobRun.findById(run.id)).toMatchObject({
        status: "failed",
        output: "saved before interruption",
        summary: { phase: "needs_review" },
      });
    }
    expect(h.stream).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled();
  });
  it("shares deployment/setup admission and refuses a patch while provisioning owns the host", async () => {
    const f = await fixture();
    const plan = await planHostPatch(f.ctx, f.id, { advisoryId: advisory.id });
    await createProvisionLock(`provision:server:${f.id}`).run(async () => {
      await expect(planHostPatch(f.ctx, f.id, { advisoryId: advisory.id })).rejects.toMatchObject({
        statusCode: 409,
      });
      const { runId } = await applyHostPatch(f.ctx, f.id, { token: plan.token });
      await h.work.shift()!();
      expect(await repos.jobRun.findById(runId)).toMatchObject({
        status: "failed",
        summary: { phase: "needs_review" },
      });
      expect(h.stream).not.toHaveBeenCalled();
    });
  });
  it("checkpoints sanitized live logs and structured steps before finishing the same run", async () => {
    const f = await fixture();
    const plan = await planHostPatch(f.ctx, f.id, { advisoryId: advisory.id });
    const { runId } = await applyHostPatch(f.ctx, f.id, { token: plan.token });
    const seen: JobRunEvent[] = [];
    const unsubscribe = jobRunBus.subscribe(runId, (event) => seen.push(event));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.stream.mockImplementation(async (_command, log) => {
      log({
        message: "package\u0000 progress https://credential@example.test/file",
        level: "info",
      });
      await gate;
      h.patched = true;
      return { code: 0, output: encode(fixed()) };
    });
    const work = h.work.shift()!();
    try {
      await vi.waitFor(() =>
        expect(seen.some((e) => e.type === "log" && e.line.includes("package progress"))).toBe(
          true,
        ),
      );
      await vi.waitFor(
        async () =>
          expect((await repos.jobRun.findById(runId))?.output).toContain("package progress"),
        { timeout: 4000 },
      );
      const during = (await repos.jobRun.findById(runId))!;
      expect(during.status).toBe("running");
      expect(during.output).not.toContain("credential");
      expect(during.output).not.toContain("\u0000");
      expect((during.summary as { steps: unknown[] }).steps).toEqual([
        expect.objectContaining({ id: "prepare", status: "completed" }),
        expect.objectContaining({ id: "apply", status: "running" }),
        expect.objectContaining({ id: "verify", status: "pending" }),
      ]);
    } finally {
      release();
      await work;
      unsubscribe();
    }
    const saved = (await repos.jobRun.findById(runId))!;
    expect(saved.status).toBe("success");
    expect(saved.output).not.toContain("OPENSHIP_HOST_SECURITY=");
    expect(seen.filter((e) => e.type === "complete")).toHaveLength(1);
    expect(
      seen.filter((e) => e.type === "log").every((e) => e.seq && !e.line.includes("credential")),
    ).toBe(true);
    expect(
      (saved.summary as { steps: { status: string }[] }).steps.every(
        (step) => step.status === "completed",
      ),
    ).toBe(true);
  });
  it("does not claim success from exit zero when the independent installed-version check fails", async () => {
    const f = await fixture();
    const plan = await planHostPatch(f.ctx, f.id, { advisoryId: advisory.id });
    h.stream.mockResolvedValue({ code: 0, output: encode(fixed()) }); // host still reports the affected version
    const { runId } = await applyHostPatch(f.ctx, f.id, { token: plan.token });
    await h.work.shift()!();
    expect(await repos.jobRun.findById(runId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("could not be verified"),
      summary: {
        phase: "needs_review",
        steps: [
          expect.objectContaining({ status: "completed" }),
          expect.objectContaining({ status: "completed" }),
          expect.objectContaining({ status: "failed" }),
        ],
      },
    });
    expect(await applyHostPatch(f.ctx, f.id, { token: plan.token })).toEqual({ runId });
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect(h.work).toHaveLength(0);
  });
  it.each(["install", "reboot"] as const)(
    "rejects incomplete target evidence after %s",
    async (operation) => {
      const f = await fixture();
      (h.feed as AdvisoryFeedState).security!.advisories[0]!.targets.push({
        kind: "host-package",
        distribution: "ubuntu",
        release: "24.04",
        package: "libssl3",
        fixedVersion: "3.0.13-0ubuntu3.5",
      });
      const full = {
        ...observed,
        rows: [
          { ...observed.rows[0]!, state: operation === "reboot" ? "reboot_required" : "affected" },
          {
            ...observed.rows[0]!,
            key: "HOST-TEST:1",
            package: "libssl3",
            state: operation === "reboot" ? "reboot_required" : "affected",
          },
        ],
      };
      h.exec.mockResolvedValue(encode(full)).mockResolvedValueOnce(
        encode({
          observation: full,
          changes:
            operation === "reboot"
              ? []
              : [...planned.changes, { ...planned.changes[0]!, package: "libssl3" }],
        }),
      );
      h.stream.mockResolvedValue({
        code: 0,
        output: encode(operation === "reboot" ? full : fixed()),
      });
      const plan = await planHostPatch(f.ctx, f.id, { advisoryId: advisory.id, operation });
      const { runId } = await applyHostPatch(f.ctx, f.id, { token: plan.token });
      if (operation === "install") h.exec.mockResolvedValue(encode(fixed()));
      await h.work.shift()!();
      if (operation === "reboot") {
        expect((await repos.jobRun.findById(runId))?.status).toBe("running");
        h.exec.mockResolvedValue(encode({ ...fixed(), bootId: "boot-b" }));
        await inspectHostSecurity(f.ctx, f.id, h.feed as AdvisoryFeedState, true);
      }
      expect(await repos.jobRun.findById(runId)).toMatchObject({
        status: "failed",
        summary: { phase: "needs_review", targetKeys: ["HOST-TEST:0", "HOST-TEST:1"] },
      });
      expect(h.stream).toHaveBeenCalledTimes(1);
      await repos.securityAdvisory.setChecksEnabled(f.owner.orgId, false);
    },
  );
  it("uses setup's component checks and reports a post-patch health regression", async () => {
    const f = await fixture();
    const plan = await planHostPatch(f.ctx, f.id, { advisoryId: advisory.id });
    h.checks.mockImplementation(async (_executor, names: string[]) =>
      names.map((name) => ({
        name,
        label: name,
        installed: true,
        healthy: !h.patched,
        message: h.patched ? "Docker daemon unavailable" : "Ready",
      })),
    );
    const { runId } = await applyHostPatch(f.ctx, f.id, { token: plan.token });
    await h.work.shift()!();
    expect(h.checks.mock.calls.map((call) => call[1])).toEqual([
      ["docker"],
      ["edge"],
      ["docker", "edge"],
    ]);
    expect(await repos.jobRun.findById(runId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("previously healthy"),
      summary: { phase: "needs_review" },
    });
  });
  it("rechecks policy after readiness probes, before any privileged command", async () => {
    const f = await fixture();
    const plan = await planHostPatch(f.ctx, f.id, { advisoryId: advisory.id });
    h.checks.mockImplementation(async () => {
      await repos.securityAdvisory.setChecksEnabled(f.owner.orgId, false);
      return [];
    });
    const { runId } = await applyHostPatch(f.ctx, f.id, { token: plan.token });
    await h.work.shift()!();
    expect(h.stream).not.toHaveBeenCalled();
    expect((await repos.jobRun.findById(runId))?.status).toBe("failed");
  });
  it("sends a default-on scoped alert once, records task status, and skips a disabled workspace", async () => {
    const f = await fixture(),
      disabled = await fixture();
    const channel = await repos.notificationChannel.create({
      userId: f.owner.userId,
      kind: "in_app",
      label: "Inbox",
      config: {},
      enabled: true,
      verified: true,
    });
    const otherChannel = await repos.notificationChannel.create({
      userId: disabled.owner.userId,
      kind: "in_app",
      label: "Inbox",
      config: {},
      enabled: true,
      verified: true,
    });
    await repos.securityAdvisory.setChecksEnabled(disabled.owner.orgId, false);
    await scanSecurityAdvisories();
    await scanSecurityAdvisories();
    const deliveries = await db
      .select()
      .from(schema.notificationDelivery)
      .where(eq(schema.notificationDelivery.channelId, channel.id));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.payload).toMatchObject({
      resourceType: "server",
      resourceId: f.id,
      durable: true,
    });
    expect(
      await db
        .select()
        .from(schema.notificationDelivery)
        .where(eq(schema.notificationDelivery.channelId, otherChannel.id)),
    ).toEqual([]);
    expect(h.exec).toHaveBeenCalledTimes(1);
    expect(await repos.securityAdvisory.scanState(f.owner.orgId)).toMatchObject({
      status: "completed",
    });
  });
  it("shares scoped read, plan, apply and history through HTTP and the native SDK", async () => {
    const f = await fixture(),
      foreign = await fixture();
    const user = (await repos.user.findById(f.owner.userId))!;
    const native = (
      await createShip({
        platform: getPlatformKernel(),
        identity: {
          resolve: async () => ({
            user: { id: user.id, email: user.email, name: user.name },
            sessionId: "host-security-test",
          }),
        },
      }).scope({ identity: "verified", organizationId: f.owner.orgId })
    ).servers;
    const app = new Hono()
      .onError(handleApiError)
      .route("/api/health", healthRoutes)
      .route("/api/system", serverResourceRoutes);
    const remote = new OpenshipClient({
      baseUrl: "http://openship.test",
      token: f.owner.token,
      organizationId: f.owner.orgId,
      fetch: ((url, init) => app.request(url as string, init)) as typeof fetch,
    }).servers;
    for (const client of [remote, native]) {
      expect((await client.checkSecurity(f.id)).findings[0]?.id).toBe(advisory.id);
      expect((await client.security(f.id)).serverId).toBe(f.id);
      await expect(client.security(foreign.id)).rejects.toThrow();
      await expect(client.securityRuns(foreign.id)).rejects.toThrow();
      await expect(
        client.planSecurityPatch(foreign.id, { advisoryId: advisory.id }),
      ).rejects.toThrow();
    }
    const plan = await remote.planSecurityPatch(f.id, { advisoryId: advisory.id });
    const { runId } = await native.applySecurityPatch(f.id, { token: plan.token });
    expect(await remote.applySecurityPatch(f.id, { token: plan.token })).toEqual({ runId });
    await h.work.shift()!();
    expect((await remote.securityRuns(f.id))[0]).toMatchObject({ id: runId, status: "success" });
    expect(await native.securityRuns(f.id)).toEqual(await remote.securityRuns(f.id));
    for (const client of [remote, native]) {
      const events = [];
      for await (const event of client.securityRunEvents(f.id, runId))
        events.push(JSON.parse(event.data));
      expect(events.map((e) => e.type)).toEqual(["snapshot", "complete"]);
      expect(events[0].run).toMatchObject({
        id: runId,
        status: "success",
        summary: { phase: "verified" },
      });
      await expect(
        client.securityRunEvents(foreign.id, runId)[Symbol.asyncIterator]().next(),
      ).rejects.toThrow();
    }
    const extra = await app.request(`/api/system/servers/${f.id}/security/plan`, {
      method: "POST",
      headers: { ...f.owner.auth, "Content-Type": "application/json" },
      body: JSON.stringify({ advisoryId: advisory.id, command: "reboot" }),
    });
    expect(extra.status).toBe(400);
  });
  it("observes once, caches with an expiry and emits no host commands without host rules", async () => {
    const f = await fixture();
    await inspectHostSecurity(f.ctx, f.id, h.feed as AdvisoryFeedState);
    await inspectHostSecurity(f.ctx, f.id, h.feed as AdvisoryFeedState);
    expect(h.exec).toHaveBeenCalledTimes(1);
    const status = await serverSecurityStatus(f.ctx, f.id);
    expect(status.findings[0]).toMatchObject({ id: "HOST-TEST", canPatch: true });
    expect(status.nextCheckAt).not.toBeNull();
    (h.feed as AdvisoryFeedState).security!.advisories = [];
    await inspectHostSecurity(f.ctx, f.id, h.feed as AdvisoryFeedState, true);
    expect(h.exec).toHaveBeenCalledTimes(1);
  });
  it("backs off unavailable observations without representing them as healthy", async () => {
    const f = await fixture();
    h.exec.mockRejectedValue(new Error("offline"));
    await inspectHostSecurity(f.ctx, f.id, h.feed as AdvisoryFeedState);
    await inspectHostSecurity(f.ctx, f.id, h.feed as AdvisoryFeedState);
    expect(h.exec).toHaveBeenCalledTimes(1);
    const state = await repos.securityAdvisory.host(f.id);
    expect(state?.probeFailures).toBe(1);
    expect(state!.nextInspectionAt!.getTime() - state!.checkedAt!.getTime()).toBeLessThan(360_000);
    expect((await serverSecurityStatus(f.ctx, f.id)).error).not.toBeNull();
  });
  it("retains known findings after a failed recheck and blocks mutation from stale evidence", async () => {
    const f = await fixture();
    await inspectHostSecurity(f.ctx, f.id, h.feed as AdvisoryFeedState);
    const before = await serverSecurityStatus(f.ctx, f.id);
    h.exec.mockRejectedValue(new Error("offline"));
    await inspectHostSecurity(f.ctx, f.id, h.feed as AdvisoryFeedState, true);
    const after = await serverSecurityStatus(f.ctx, f.id);
    expect(after.checkedAt).toBe(before.checkedAt);
    expect(after.error).not.toBeNull();
    expect(after.findings[0]).toMatchObject({ id: "HOST-TEST", canPatch: false, canReboot: false });
  });
  it("expires healthy observations and excludes disabled workspaces from host selection", async () => {
    const f = await fixture();
    await inspectHostSecurity(f.ctx, f.id, h.feed as AdvisoryFeedState);
    const row = await repos.securityAdvisory.host(f.id);
    vi.spyOn(Date, "now").mockReturnValue(row!.nextInspectionAt!.getTime() + 1);
    await inspectHostSecurity(f.ctx, f.id, h.feed as AdvisoryFeedState);
    expect(h.exec).toHaveBeenCalledTimes(2);
    await repos.securityAdvisory.setChecksEnabled(f.owner.orgId, false);
    expect(
      (await repos.securityAdvisory.hostCandidates("changed-rules")).map((r) => r.server.id),
    ).not.toContain(f.id);
  });
  it("rejects tampered, expired, wrong-server and cross-workspace approval tokens", async () => {
    const f = await fixture(),
      foreign = await fixture();
    const plan = await planHostPatch(f.ctx, f.id, { advisoryId: advisory.id });
    expect(() => decodeHostPatchToken(plan.token.slice(1))).toThrow();
    await expect(applyHostPatch(f.ctx, foreign.id, { token: plan.token })).rejects.toThrow();
    await expect(applyHostPatch(foreign.ctx, f.id, { token: plan.token })).rejects.toThrow();
    vi.spyOn(Date, "now").mockReturnValue(Date.parse(plan.expiresAt) + 1);
    await expect(applyHostPatch(f.ctx, f.id, { token: plan.token })).rejects.toThrow(/expired/);
    expect(h.stream).not.toHaveBeenCalled();
  });
  it("rejects changed advisories and connection identities after review", async () => {
    const f = await fixture();
    const plan = await planHostPatch(f.ctx, f.id, { advisoryId: advisory.id });
    (h.feed as AdvisoryFeedState).security!.advisories[0]!.revision++;
    await expect(applyHostPatch(f.ctx, f.id, { token: plan.token })).rejects.toThrow(/changed/);
    (h.feed as AdvisoryFeedState).security!.advisories[0]!.revision--;
    await db
      .update(schema.servers)
      .set({ sshHost: "other.example.test" })
      .where(eq(schema.servers.id, f.id));
    await expect(applyHostPatch(f.ctx, f.id, { token: plan.token })).rejects.toThrow(/changed/);
  });
  it("runs once, stores verified history, and keeps other servers isolated", async () => {
    const f = await fixture(),
      other = await fixture();
    const plan = await planHostPatch(f.ctx, f.id, { advisoryId: advisory.id });
    const first = await applyHostPatch(f.ctx, f.id, { token: plan.token });
    expect(await applyHostPatch(f.ctx, f.id, { token: plan.token })).toEqual(first);
    expect(h.work).toHaveLength(1);
    await h.work[0]!();
    expect(h.stream).toHaveBeenCalledTimes(1);
    expect((await hostPatchRuns(f.ctx, f.id))[0]).toMatchObject({
      id: first.runId,
      status: "success",
      summary: { phase: "verified" },
    });
    await expect(hostPatchRuns(other.ctx, f.id)).rejects.toThrow();
  });
  it("rechecks disabled inspection policy and revoked server access in the worker", async () => {
    for (const revoke of [false, true]) {
      const f = await fixture();
      const plan = await planHostPatch(f.ctx, f.id, { advisoryId: advisory.id });
      const run = await applyHostPatch(f.ctx, f.id, { token: plan.token });
      if (revoke) await db.delete(schema.member).where(eq(schema.member.userId, f.owner.userId));
      else await repos.securityAdvisory.setChecksEnabled(f.owner.orgId, false);
      await h.work.shift()!().catch(() => {});
      expect((await repos.jobRun.findById(run.runId))?.status).toBe("failed");
    }
    expect(h.stream).not.toHaveBeenCalled();
  });
  it("keeps a reboot run pending until a new boot reports the fixed running kernel", async () => {
    const f = await fixture();
    const reboot = {
      ...observed,
      rows: [{ ...observed.rows[0], state: "reboot_required", canPatch: false }],
    };
    h.exec.mockResolvedValue(encode(reboot));
    h.exec.mockResolvedValueOnce(encode({ observation: reboot, changes: [] }));
    h.stream.mockResolvedValue({ code: 0, output: encode(reboot) });
    const plan = await planHostPatch(f.ctx, f.id, { advisoryId: advisory.id, operation: "reboot" });
    const { runId } = await applyHostPatch(f.ctx, f.id, { token: plan.token });
    await h.work.shift()!();
    expect(await repos.jobRun.findById(runId)).toMatchObject({
      status: "running",
      summary: { phase: "rebooting" },
    });
    // The engine may restart along with the host. Preserve verification, never replay the reboot.
    await repos.jobRun.failStaleRunning();
    expect((await repos.jobRun.findById(runId))?.status).toBe("running");
    const pending = await repos.securityAdvisory.host(f.id);
    expect(pending!.nextInspectionAt!.getTime() - pending!.checkedAt!.getTime()).toBe(60_000);
    expect(pending!.probeFailures).toBe(0);
    h.exec.mockResolvedValue(
      encode({ ...reboot, bootId: "boot-b", rows: [{ ...reboot.rows[0], state: "fixed" }] }),
    );
    await inspectHostSecurity(f.ctx, f.id, h.feed as AdvisoryFeedState, true);
    expect(await repos.jobRun.findById(runId)).toMatchObject({
      status: "success",
      summary: { phase: "verified" },
    });
  });
  it("rejects provider-managed hosts, Cloud control-plane hosts and import-only connections", async () => {
    const f = await fixture();
    const original = await repos.server.getInOrganization(f.id, f.owner.orgId);
    const read = vi.spyOn(repos.server, "getInOrganization");
    for (const changes of [{ workspaceId: "managed" }, { purpose: "migration_source" as const }]) {
      read.mockResolvedValue({ ...original!, ...changes });
      await expect(planHostPatch(f.ctx, f.id, { advisoryId: advisory.id })).rejects.toThrow();
    }
    read.mockResolvedValue({ ...original!, isLocal: true });
    const old = env.CLOUD_MODE;
    env.CLOUD_MODE = true;
    try {
      await expect(planHostPatch(f.ctx, f.id, { advisoryId: advisory.id })).rejects.toThrow();
    } finally {
      env.CLOUD_MODE = old;
    }
    expect(h.exec).not.toHaveBeenCalled();
  });
});
