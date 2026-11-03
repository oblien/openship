import { beforeEach, describe, expect, it, vi } from "vitest";
import { repos, seedOwner, seedServer, db, schema } from "../jobs/_harness";
import { eq } from "drizzle-orm";
import { buildBackgroundContext } from "@repo/platform/engine/lib/background-context";
import { env } from "@repo/platform/engine/config/env";
import {
  planHostPatch,
  applyHostPatch,
  inspectHostSecurity,
  serverSecurityStatus,
  hostPatchRuns,
  decodeHostPatchToken,
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
  work: [] as (() => Promise<unknown>)[],
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
  h.exec.mockReset().mockImplementation(async (cmd: string) => {
    // Decode only the generated base64 argument, never execute a host command in these tests.
    const args = JSON.parse(
      Buffer.from(cmd.match(/'([A-Za-z0-9+/=]+)'(?:; fi)?$/)![1], "base64").toString(),
    );
    return encode(args.mode.startsWith("plan") ? planned : observed);
  });
  h.stream.mockReset().mockResolvedValue({
    code: 0,
    output: encode({
      ...observed,
      rows: [
        {
          ...observed.rows[0],
          state: "fixed",
          installed: planned.changes[0].version,
          candidate: null,
          canPatch: false,
        },
      ],
    }),
  });
});
describe("server advisory maintenance", () => {
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
