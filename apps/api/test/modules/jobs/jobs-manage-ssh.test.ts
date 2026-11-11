/** Real Cloud HTTP/auth/database/scheduler/SSH execution. Only DNS and the final
 * public-IP dial are redirected to an isolated SSH fixture on this test machine.
 * No customer host, provider VM or control-plane executor is used. */
import "./_env";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server as SshServer, utils, type Connection } from "ssh2";

const network = vi.hoisted(() => ({
  dns: vi.fn(),
  create: vi.fn(),
  host: vi.fn(() => { throw new Error("Cloud jobs must never acquire the control-plane executor"); }),
  port: 0,
  fail: false,
}));
vi.mock("@repo/platform/engine/config/env", async (load) => {
  const actual = await load<typeof import("@repo/platform/engine/config/env")>();
  return { ...actual, env: { ...actual.env, CLOUD_MODE: true } };
});
vi.mock("node:dns/promises", async (load) => ({
  ...await load<typeof import("node:dns/promises")>(), lookup: network.dns,
}));
vi.mock("@repo/adapters", async (load) => {
  const actual = await load<typeof import("@repo/adapters")>();
  network.create.mockImplementation((config) => {
    if (network.fail) throw new Error("SSH fixture unavailable");
    // Production validation must run before this final test-only dial redirect.
    if (!config || config.host !== "93.184.216.34" || config.useSystemSsh)
      throw new Error("An unvalidated SSH destination reached the executor");
    return actual.createExecutor({ ...config, host: "127.0.0.1", port: network.port });
  });
  return { ...actual, createExecutor: network.create, createHostExecutor: network.host };
});

import { eq, type Server } from "@repo/db";
import { makeApp, seedOwner, resetJobs, installFakeRunner, req, db, schema, repos } from "./_harness";
import { managementNamespace } from "@repo/platform/engine/modules/billing/management.service";
import { encryptSecretField } from "@repo/platform/engine/lib/credential-encryption";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import { drainBackgroundWork } from "@repo/platform/engine/lib/background-work";
import { runCommandJobTick, runDueOnceJobs } from "@repo/platform/engine/modules/jobs/job-command";
import { fireJobTriggers } from "@repo/platform/engine/modules/jobs/job-events";
import * as managedAccess from "@repo/platform/engine/lib/cloud-workspace-access";

const app = makeApp();
const runner = installFakeRunner();
const hostKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs1", format: "pem" }).toString();
const parsedKey = utils.parseKey(hostKey);
if (parsedKey instanceof Error || Array.isArray(parsedKey)) throw new Error("Invalid fixture host key");
const connections = new Set<Connection>();
const commands: string[] = [];
let ssh: SshServer;
let directory: string;
let onCommand: (() => Promise<void>) | undefined;

beforeAll(async () => {
  ssh = new SshServer({ hostKeys: [hostKey] }, (client) => {
    connections.add(client);
    client.on("error", () => {});
    client.on("close", () => connections.delete(client));
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === "fixture" && ctx.password === "fixture-password") ctx.accept();
      else ctx.reject();
    });
    client.on("ready", () => client.on("session", (accept) => {
      accept().on("exec", (accept, _reject, info) => {
        const channel = accept();
        commands.push(info.command);
        void (async () => {
          await onCommand?.();
          // Only test-authored commands reach this disposable fixture directory.
          const child = spawn("/bin/sh", ["-c", info.command], { cwd: directory, env: { PATH: "/usr/bin:/bin" } });
          child.stdout.pipe(channel, { end: false });
          child.stderr.pipe(channel.stderr, { end: false });
          channel.on("close", () => child.kill("SIGTERM"));
          child.on("error", (error) => { channel.stderr.write(error.message); channel.exit(1); channel.end(); });
          child.on("close", (code) => { channel.exit(code ?? 1); channel.end(); });
        })().catch((error) => { channel.stderr.write(String(error)); channel.exit(1); channel.end(); });
      });
    }));
  });
  await new Promise<void>(resolve => ssh.listen(0, "127.0.0.1", resolve));
  network.port = (ssh.address() as { port: number }).port;
});

beforeEach(async () => {
  await resetJobs();
  runner.recurring.clear();
  network.dns.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  network.create.mockClear();
  network.host.mockClear();
  network.fail = false;
  commands.length = 0;
  onCommand = undefined;
  directory = await mkdtemp(join(tmpdir(), "openship-manage-job-"));
});
afterEach(async () => {
  await drainBackgroundWork();
  sshManager.invalidate();
  for (const client of connections) client.end();
  await rm(directory, { recursive: true, force: true });
  expect(network.host).not.toHaveBeenCalled();
});
afterAll(async () => {
  await sshManager.destroy();
  for (const client of connections) client.end();
  await new Promise<void>(resolve => ssh.close(() => resolve()));
});

async function owner() {
  const actor = await seedOwner();
  await repos.managementBilling.ensure(actor.orgId, managementNamespace(actor.orgId));
  await repos.managementBilling.update(actor.orgId, {
    checkedAt: new Date(),
    verified: { servers: 3, baseIncluded: false, priceCents: 700, status: "active",
      cancelAtPeriodEnd: false, periodEnd: new Date(Date.now() + 86_400_000).toISOString() },
  });
  const server = await repos.server.create({
    organizationId: actor.orgId, name: "Customer SSH", sshHost: "customer.example",
    sshUser: "fixture", sshAuthMethod: "password", sshPassword: encryptSecretField("fixture-password"),
    sshHostKey: parsedKey.getPublicSSH().toString("base64"),
  });
  return { ...actor, server };
}
type Owner = Awaited<ReturnType<typeof owner>>;
const request = (actor: Owner, method: string, path: string, body?: unknown) =>
  req(app, method, path, { auth: actor.auth, body });
async function create(actor: Owner, patch: Record<string, unknown> = {}) {
  const response = await request(actor, "POST", "/", {
    label: "Customer job", command: "printf 'remote-ok\\n'", serverIds: [actor.server.id], scheduleType: "manual", ...patch,
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.data.key as string;
}
async function run(actor: Owner, key: string) {
  const response = await request(actor, "POST", `/${key}/run`);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  await drainBackgroundWork();
  return (await repos.jobRun.findById(response.body.data.runId))!;
}
async function revoke(actor: Owner) {
  await repos.managementBilling.update(actor.orgId, { checkedAt: new Date(), verified: null });
}

it("creates, edits, runs and reads a Cloud job through pinned customer SSH", async () => {
  const actor = await owner();
  const key = await create(actor, { command: "printf '%s\\n' \"$MARKER\"", env: { MARKER: "from-customer-ssh" }, secrets: { TOKEN: "private-token" } });
  expect((await request(actor, "GET", `/${key}`)).body.data.actionConfig.secrets).toEqual({ TOKEN: "" });
  expect((await request(actor, "PATCH", `/${key}`, { label: "Renamed" })).status).toBe(200);
  const result = await run(actor, key);
  expect(result).toMatchObject({ status: "success", output: "from-customer-ssh\n", serverIds: [actor.server.id] });
  expect(network.create).toHaveBeenCalledWith(expect.objectContaining({ host: "93.184.216.34", username: "fixture", hostVerifier: expect.any(Function) }));
  expect((await request(actor, "GET", `/runs/${result.id}`)).body.data.output).toBe(result.output);
  expect((await request(actor, "GET", `/${key}/runs`)).body.data).toHaveLength(1);
  expect(JSON.stringify((await request(actor, "GET", "/")).body)).not.toContain("private-token");
});

it.each(["schedule", "once", "event", "dependency"])("executes %s jobs through the same SSH boundary", async (trigger) => {
  const actor = await owner();
  const parent = trigger === "dependency" ? await create(actor) : undefined;
  const key = await create(actor, {
    ...(trigger === "schedule" ? { scheduleType: "recurring", cronExpression: "*/5 * * * *" } : {}),
    ...(trigger === "event" ? { triggerEvents: ["deployment.failed"] } : {}),
    ...(parent ? { dependsOn: [parent] } : {}),
  });
  if (trigger === "schedule") {
    expect(runner.recurring.has(key)).toBe(true);
    await runner.tick(key);
  } else if (trigger === "once") {
    await repos.job.update(key, { scheduleType: "once", runAt: new Date(Date.now() - 1000) });
    expect(await runDueOnceJobs()).toEqual({ fired: 1 });
  } else if (trigger === "event") fireJobTriggers("deployment.failed", actor.orgId);
  else await run(actor, parent!);
  await drainBackgroundWork();
  const [result] = await repos.jobRun.listRecent({ jobId: key });
  expect(result).toMatchObject({ trigger, status: "success", output: "remote-ok\n" });
  expect(commands.length).toBe(parent ? 2 : 1);
});

it("retries through SSH with one durable run and succeeds on the second attempt", async () => {
  const actor = await owner();
  const key = await create(actor, { command: "if [ ! -f attempted ]; then touch attempted; exit 1; fi; printf recovered",
    retry: { maxAttempts: 2, backoffSeconds: 0 } });
  expect(await run(actor, key)).toMatchObject({ status: "success", summary: { attempts: 2 } });
  expect(commands).toHaveLength(2);
  expect(await repos.jobRun.listRecent({ jobId: key })).toHaveLength(1);
});

it("checks Manage access before scheduled work and keeps expired jobs readable and removable", async () => {
  const actor = await owner();
  const key = await create(actor, { scheduleType: "recurring", cronExpression: "*/5 * * * *" });
  await revoke(actor);
  expect((await request(actor, "POST", `/${key}/run`)).body.code).toBe("MANAGEMENT_PLAN_REQUIRED");
  await runner.tick(key);
  expect((await repos.jobRun.listRecent({ jobId: key }))[0]).toMatchObject({ status: "failed" });
  expect(network.create).not.toHaveBeenCalled();
  expect(commands).toHaveLength(0);
  expect((await request(actor, "GET", `/${key}`)).status).toBe(200);
  expect((await request(actor, "GET", "/")).body.data).toHaveLength(1);
  expect((await request(actor, "PATCH", `/${key}`, { enabled: false })).status).toBe(200);
  expect((await request(actor, "DELETE", `/${key}`)).status).toBe(200);
});

it("rechecks Manage access between retries even with a pooled SSH connection", async () => {
  const actor = await owner();
  const key = await create(actor, { command: "exit 1", retry: { maxAttempts: 2, backoffSeconds: 0 } });
  onCommand = () => revoke(actor);
  expect(await run(actor, key)).toMatchObject({ status: "failed", summary: { attempts: 2 }, error: expect.stringContaining("Manage plan") });
  expect(commands).toHaveLength(1);
});

it("rejects ownership changes before retrying on an already connected server", async () => {
  const actor = await owner();
  const other = await owner();
  const key = await create(actor, { command: "exit 1", retry: { maxAttempts: 2, backoffSeconds: 0 } });
  onCommand = async () => { await db.update(schema.servers).set({ organizationId: other.orgId }).where(eq(schema.servers.id, actor.server.id)); };
  expect(await run(actor, key)).toMatchObject({ status: "failed", error: "Job target server not found" });
  expect(commands).toHaveLength(1);
});

it("isolates configuration, mutations, runs and streams between organizations", async () => {
  const actor = await owner();
  const other = await owner();
  const key = await create(actor);
  const result = await run(actor, key);
  for (const [method, path, body] of [
    ["GET", `/${key}`], ["PATCH", `/${key}`, { command: "printf changed" }],
    ["DELETE", `/${key}`], ["POST", `/${key}/run`], ["GET", `/${key}/runs`],
    ["GET", `/runs/${result.id}`], ["GET", `/runs/${result.id}/stream`],
    ["POST", "/", { label: "Foreign", command: "true", serverIds: [actor.server.id], scheduleType: "manual" }],
  ] as const) expect((await request(other, method, path, body)).status, path).toBe(404);
  expect((await request(other, "GET", "/")).body.data).toEqual([]);
  expect((await request(actor, "PATCH", `/${key}`, { serverIds: [other.server.id] })).status).toBe(404);
  expect(commands).toHaveLength(1);
});

it("requires server administration in addition to Jobs write permission", async () => {
  const actor = await owner();
  await db.update(schema.member).set({ role: "restricted" }).where(eq(schema.member.userId, actor.userId));
  await repos.resourceGrant.upsert({ organizationId: actor.orgId, userId: actor.userId, resourceType: "job", resourceId: "*", permissions: ["write"], grantedByUserId: null });
  const input = { label: "Scoped", command: "true", serverIds: [actor.server.id], scheduleType: "manual" };
  expect((await request(actor, "POST", "/", input)).status).toBe(404);
  await repos.resourceGrant.upsert({ organizationId: actor.orgId, userId: actor.userId, resourceType: "server", resourceId: actor.server.id, permissions: ["admin"], grantedByUserId: null });
  expect((await request(actor, "POST", "/", input)).status).toBe(201);
  expect(commands).toHaveLength(0);
});

it("keeps internal Cloud system jobs unavailable to customer administrators", async () => {
  const actor = await owner();
  const key = "jobs:run-prune";
  await repos.job.create({ key, label: "Internal job", kind: "system", actionType: "builtin" });
  expect((await request(actor, "GET", "/")).body.data).toEqual([]);
  expect((await request(actor, "GET", `/${key}`)).status).toBe(404);
  expect((await request(actor, "POST", `/${key}/run`)).status).toBe(404);
  expect((await request(actor, "PATCH", `/${key}`, { enabled: false })).status).toBe(404);
});

it("runs on several authorized SSH targets and preserves their output attribution", async () => {
  const actor = await owner();
  const { id: _id, createdAt: _created, updatedAt: _updated, ...settings } = actor.server;
  const second = await repos.server.create({ ...settings, name: "Second SSH server" });
  const key = await create(actor, { serverIds: [actor.server.id, second.id] });
  const result = await run(actor, key);
  expect(result).toMatchObject({ status: "success", serverId: null, serverIds: [actor.server.id, second.id] });
  expect(result.output).toContain(actor.server.id);
  expect(result.output).toContain(second.id);
  expect(commands).toHaveLength(2);
});

it("blocks mixed-organization stored jobs before any SSH execution", async () => {
  const actor = await owner();
  const other = await owner();
  const key = await create(actor, { scheduleType: "recurring", cronExpression: "*/5 * * * *" });
  await repos.job.update(key, { actionConfig: { serverIds: [actor.server.id, other.server.id], command: "true" } });
  await runCommandJobTick(key);
  expect((await repos.jobRun.listRecent({ jobId: key }))[0]).toMatchObject({ status: "failed" });
  expect(network.create).not.toHaveBeenCalled();
});

it("does not dispatch a job for an event from another organization", async () => {
  const actor = await owner();
  const other = await owner();
  const key = await create(actor, { triggerEvents: ["deployment.failed"] });
  fireJobTriggers("deployment.failed", other.orgId);
  await drainBackgroundWork();
  expect(await repos.jobRun.listRecent({ jobId: key })).toEqual([]);
  expect(network.create).not.toHaveBeenCalled();
});

it("aborts a timed-out SSH command and records a terminal failed run", async () => {
  const actor = await owner();
  const key = await create(actor, { command: "exec sleep 30", timeoutMs: 1000 });
  expect(await run(actor, key)).toMatchObject({ status: "failed", error: "Command timed out after 1000ms" });
  expect(commands).toHaveLength(1);
});

it.each([
  { isLocal: true }, { sshHost: "" }, { purpose: "migration_source" },
] satisfies Partial<Server>[])("rejects control-plane or import-only targets on create and scheduled execution: %j", async (patch) => {
  const actor = await owner();
  const key = await create(actor, { scheduleType: "recurring", cronExpression: "*/5 * * * *" });
  await repos.server.update(actor.server.id, patch);
  expect((await request(actor, "POST", "/", { label: "Blocked", command: "true", serverIds: [actor.server.id], scheduleType: "manual" })).status).toBe(403);
  await runCommandJobTick(key);
  expect((await repos.jobRun.listRecent({ jobId: key }))[0]).toMatchObject({ status: "failed" });
  expect(network.create).not.toHaveBeenCalled();
});

it.each([
  { sshAuthMethod: "agent" }, { sshKeyPath: "/root/.ssh/id_rsa" },
  { sshJumpHost: "root@127.0.0.1" }, { sshArgs: "-oProxyCommand=sh" },
  { sshTransport: "cloudflare" }, { sshHostKey: null },
] satisfies Partial<Server>[])("never uses operator SSH identity or unpinned legacy connections: %j", async (patch) => {
  const actor = await owner();
  const key = await create(actor);
  await repos.server.update(actor.server.id, patch);
  expect(await run(actor, key)).toMatchObject({ status: "failed" });
  expect(network.create).not.toHaveBeenCalled();
  expect(commands).toHaveLength(0);
});

it.each(["127.0.0.1", "::1", "10.0.0.1", "169.254.169.254"])("rejects DNS rebinding to %s before opening SSH", async (address) => {
  const actor = await owner();
  const key = await create(actor);
  network.dns.mockResolvedValue([{ address, family: address.includes(":") ? 6 : 4 }]);
  expect(await run(actor, key)).toMatchObject({ status: "failed" });
  expect(network.create).not.toHaveBeenCalled();
  expect(commands).toHaveLength(0);
});

it("refuses a changed SSH host key without executing the command", async () => {
  const actor = await owner();
  const key = await create(actor);
  await repos.server.update(actor.server.id, { sshHostKey: Buffer.from("different-host").toString("base64") });
  expect(await run(actor, key)).toMatchObject({ status: "failed" });
  expect(commands).toHaveLength(0);
});

it("does not fall back to the control plane when the customer SSH connection fails", async () => {
  const actor = await owner();
  const key = await create(actor);
  network.fail = true;
  expect(await run(actor, key)).toMatchObject({ status: "failed", error: "SSH fixture unavailable" });
  expect(commands).toHaveLength(0);
});

it("validates every target before starting a multi-server attempt", async () => {
  const actor = await owner();
  const second = await repos.server.create({ organizationId: actor.orgId, name: "Invalid local row", isLocal: true, sshHost: "127.0.0.1" });
  const key = await create(actor, { scheduleType: "recurring", cronExpression: "*/5 * * * *" });
  await repos.job.update(key, { actionConfig: { serverIds: [actor.server.id, second.id], command: "true" } });
  await runCommandJobTick(key);
  expect((await repos.jobRun.listRecent({ jobId: key }))[0]).toMatchObject({ status: "failed" });
  expect(network.create).not.toHaveBeenCalled();
});

it("preserves managed-Cloud admission when a job mixes SSH and provider targets", async () => {
  const actor = await owner();
  const workspaceId = `cws_${actor.orgId}`;
  await db.insert(schema.cloudWorkspace).values({ id: workspaceId, organizationId: actor.orgId, name: "Cloud" });
  const managed = await repos.server.create({ organizationId: actor.orgId, workspaceId });
  const key = await create(actor, { serverIds: [actor.server.id, managed.id] });
  const { AppError } = await import("@repo/core");
  const gate = vi.spyOn(managedAccess, "assertManagedServerCanWork").mockRejectedValue(new AppError("Cloud balance unavailable", 402, "CLOUD_BILLING_BLOCKED"));
  try {
    const response = await request(actor, "POST", `/${key}/run`);
    expect(response.status).toBe(402);
    expect(response.body).toMatchObject({ code: "CLOUD_BILLING_BLOCKED", workspaceId, serverId: managed.id });
    expect(gate).toHaveBeenCalledWith(actor.orgId, workspaceId);
    expect(network.create).not.toHaveBeenCalled();
  } finally { gate.mockRestore(); }
});

it("fails deleted targets without running on another host", async () => {
  const actor = await owner();
  const key = await create(actor, { scheduleType: "recurring", cronExpression: "*/5 * * * *" });
  await repos.server.delete(actor.server.id);
  await runCommandJobTick(key);
  expect((await repos.jobRun.listRecent({ jobId: key }))[0]).toMatchObject({ status: "failed" });
  expect(network.create).not.toHaveBeenCalled();
});
