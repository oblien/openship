import "../jobs/_env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Hono } from "hono";
const network = vi.hoisted(() => ({
  create: vi.fn(),
  exec: vi.fn(),
  dispose: vi.fn(),
  dns: vi.fn(),
  probe: vi.fn(),
  portProbe: vi.fn(),
  install: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/config/env")>();
  return { ...actual, env: { ...actual.env, CLOUD_MODE: true } };
});
vi.mock("node:dns/promises", async (original) => ({
  ...(await original<typeof import("node:dns/promises")>()),
  lookup: network.dns,
}));
vi.mock("@repo/adapters", async (original) => {
  const actual = await original<typeof import("@repo/adapters")>();
  return {
    ...actual,
    createExecutor: network.create,
    probeTcp: network.probe,
    probeTcpDetailed: network.portProbe,
    COMPONENT_INSTALLERS: { ...actual.COMPONENT_INSTALLERS, docker: network.install },
  };
});
import { db, repos, schema } from "@repo/db";
import { seedOwner } from "../jobs/_harness";
import { connectedServerRoutes } from "../../../src/modules/system/connected-server.routes";
import { serverResourceRoutes } from "../../../src/modules/system/server-resource.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { managementNamespace } from "@repo/platform/engine/modules/billing/management.service";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import { probePortsFromControlPlane } from "@repo/platform/engine/lib/port-reachability";
import {
  createSetupSession,
  removeSetupSession,
} from "@repo/platform/engine/modules/system/setup-session";
import { drainServerInstallations } from "@repo/platform/engine/modules/system/server-install.operations";
const app = new Hono()
  .onError(handleApiError)
  .route("/api/system", serverResourceRoutes)
  .route("/api/system", connectedServerRoutes);
const hostKey = Buffer.from("fixture-host-key");
const input = {
  sshHost: "93.184.216.34",
  sshAuthMethod: "password",
  sshPassword: "fixture-secret",
};
const connections: string[] = [];
const sessions: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  network.exec.mockResolvedValue("");
  network.dispose.mockResolvedValue(undefined);
  network.dns.mockResolvedValue([{ address: input.sshHost, family: 4 }]);
  network.probe.mockResolvedValue(true);
  network.portProbe.mockResolvedValue({ ok: true });
  network.install.mockResolvedValue({ component: "docker", success: true });
  network.create.mockImplementation((config) => {
    if (!config.hostVerifier(hostKey)) throw new Error("Wrong host identity");
    return { exec: network.exec, dispose: network.dispose };
  });
});
afterEach(async () => {
  await drainServerInstallations();
  for (const id of sessions.splice(0)) removeSetupSession(id);
  for (const id of connections.splice(0)) sshManager.invalidate(id);
});

async function connectedOwner() {
  const { actor, create } = await owner();
  expect((await create({ ...input, sshHost: "customer.example" })).status).toBe(201);
  const server = (await repos.server.listByOrganization(actor.orgId))[0]!;
  connections.push(server.id);
  return { actor, server };
}

it("pins the actual reachability dial and refuses DNS rebinding before probing", async () => {
  const { actor, server } = await connectedOwner();
  const reachability = () =>
    app.request(`/api/system/servers/${server.id}/reachability`, { headers: actor.auth });
  expect((await reachability()).ok).toBe(true);
  expect(network.probe).toHaveBeenLastCalledWith(input.sshHost, 22, 2500);
  network.probe.mockClear();
  network.dns.mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);
  expect(await (await reachability()).json()).toMatchObject({ reachable: false });
  expect(network.probe).not.toHaveBeenCalled();
});

it("pins every off-box port probe and rejects mixed public/private DNS answers", async () => {
  expect(await probePortsFromControlPlane("customer.example", [443, 5432, 443])).toHaveLength(2);
  expect(network.dns).toHaveBeenCalledTimes(1);
  expect(network.portProbe.mock.calls.map(([host]) => host)).toEqual([
    input.sshHost,
    input.sshHost,
  ]);
  network.portProbe.mockClear();
  network.dns.mockResolvedValue([
    { address: input.sshHost, family: 4 },
    { address: "169.254.169.254", family: 4 },
  ]);
  await expect(probePortsFromControlPlane("customer.example", [443])).rejects.toThrow();
  expect(network.portProbe).not.toHaveBeenCalled();
});

it("requires paid access before reporting a cached connection as reachable", async () => {
  const { actor, server } = await connectedOwner();
  await sshManager.withExecutor(server.id, (executor) => executor.exec("true"));
  await repos.managementBilling.update(actor.orgId, { checkedAt: new Date(), verified: null });
  await expect(sshManager.diagnoseReachability(server.id)).rejects.toMatchObject({
    code: "MANAGEMENT_PLAN_REQUIRED",
  });
  expect(network.probe).not.toHaveBeenCalled();
});

it("scopes installation discovery, named replay and prompt replies to the tenant", async () => {
  const a = await connectedOwner();
  const b = await connectedOwner();
  const active = createSetupSession([{ name: "docker", label: "Private install" }], a.server.id);
  sessions.push(active.id);
  const get = (query: string, auth = b.actor.auth) =>
    app.request(`/api/system/install/session${query}`, { headers: auth });
  expect(await (await get("")).json()).toEqual({ active: false });
  expect(await (await get(`?serverId=${b.server.id}`)).json()).toEqual({ active: false });
  for (const query of [`?sessionId=${active.id}`, `?id=${active.id}`, `?serverId=${a.server.id}`]) {
    const response = await get(query);
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("Private install");
  }
  expect((await get(`?sessionId=${active.id}&serverId=${b.server.id}`)).status).toBe(404);
  expect((await get(`?sessionId=${active.id}&id=different`, a.actor.auth)).status).toBe(400);
  expect(
    (
      await app.request(`/api/system/install/stream?sessionId=${active.id}`, {
        headers: b.actor.auth,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await app.request("/api/system/install/respond", {
        method: "POST",
        headers: { ...b.actor.auth, "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: active.id, action: "override" }),
      })
    ).status,
  ).toBe(404);
  for (const query of [
    "",
    `?sessionId=${active.id}`,
    `?id=${active.id}`,
    `?serverId=${a.server.id}`,
  ]) {
    expect(await (await get(query, a.actor.auth)).json()).toMatchObject({
      active: true,
      sessionId: active.id,
      serverId: a.server.id,
    });
  }
});

it("rejects foreign server reads, mutations and streams before any host access", async () => {
  const a = await connectedOwner();
  const b = await owner();
  network.create.mockClear();
  network.exec.mockClear();
  const requests = [
    ["GET", `/servers/${a.server.id}`],
    ["GET", `/servers/${a.server.id}/reachability`],
    ["POST", `/servers/${a.server.id}/exec`, { command: "true" }],
    ["POST", `/servers/${a.server.id}/ports/scan`],
    ["GET", `/monitor/stream?serverId=${a.server.id}`],
    ["POST", "/install", { serverId: a.server.id, component: "docker" }],
    ["POST", "/install/stream", { serverId: a.server.id, components: ["docker"] }],
    ["PATCH", `/servers/${a.server.id}`, { name: "foreign" }],
    ["DELETE", `/servers/${a.server.id}`],
  ] as const;
  for (const [method, path, body] of requests) {
    const response = await app.request(`/api/system${path}`, {
      method,
      headers: { ...b.actor.auth, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    expect(response.status, path).toBe(404);
    expect(await response.text()).not.toContain(input.sshPassword);
  }
  expect(network.create).not.toHaveBeenCalled();
  expect(network.exec).not.toHaveBeenCalled();
  expect(network.probe).not.toHaveBeenCalled();
  expect(await repos.server.get(a.server.id)).toMatchObject({ organizationId: a.actor.orgId });
});

it.each([
  { sshAuthMethod: "agent" },
  { sshKeyPath: "/root/.ssh/id_rsa" },
  { sshJumpHost: "root@127.0.0.1" },
  { sshArgs: "-oProxyCommand=sh" },
  { sshTransport: "cloudflare" },
  { sshUser: "root;id" },
])("refuses operator SSH configuration from a Cloud tenant: %j", async (options) => {
  const { create } = await owner();
  expect((await create({ ...input, ...options })).status).toBe(400);
  expect(network.create).not.toHaveBeenCalled();
});

it("allows independent tenant installs while refusing overlapping work on the same server", async () => {
  const a = await connectedOwner();
  const b = await connectedOwner();
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  network.install.mockImplementation(async () => {
    await held;
    return { component: "docker", success: true };
  });
  const start = (target: typeof a, path = "/install/stream", component = false) =>
    app.request(`/api/system${path}`, {
      method: "POST",
      headers: { ...target.actor.auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        serverId: target.server.id,
        ...(component ? { component: "docker" } : { components: ["docker"] }),
      }),
    });
  try {
    const first = await start(a);
    expect(first.status).toBe(200);
    await vi.waitFor(() => expect(network.install).toHaveBeenCalledTimes(1));
    const second = await start(b);
    expect(second.status).toBe(200);
    await vi.waitFor(() => expect(network.install).toHaveBeenCalledTimes(2));
    expect((await start(a)).status).toBe(409);
    expect((await start(a, "/install", true)).status).toBe(409);
    // The first tenant's session must not hide the second tenant's running work.
    const lookup = await app.request("/api/system/install/session", { headers: b.actor.auth });
    const state = (await lookup.json()) as { sessionId: string };
    expect(state).toMatchObject({ active: true, serverId: b.server.id });
    finish();
    await Promise.all([first.text(), second.text()]);
    await drainServerInstallations();
    expect((await start(a, "/install", true)).status).toBe(200);
  } finally {
    finish();
  }
});

it("refuses the connected-server delete lifecycle before enumerating a managed server's projects", async () => {
  const { actor } = await owner();
  const workspaceId = `cws_${actor.orgId}`;
  const serverId = crypto.randomUUID();
  await db
    .insert(schema.cloudWorkspace)
    .values({ id: workspaceId, organizationId: actor.orgId, name: "Cloud" });
  await db
    .insert(schema.servers)
    .values({ id: serverId, organizationId: actor.orgId, workspaceId });
  const projects = vi.spyOn(repos.project, "listActiveByServer");
  try {
    const response = await app.request(`/api/system/servers/${serverId}`, {
      method: "DELETE",
      headers: actor.auth,
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "MANAGED_SERVER_LIFECYCLE_REQUIRED" });
    expect(projects).not.toHaveBeenCalled();
    expect(await repos.server.get(serverId)).toBeDefined();
  } finally {
    projects.mockRestore();
  }
});
async function owner() {
  const actor = await seedOwner();
  await repos.managementBilling.ensure(actor.orgId, managementNamespace(actor.orgId));
  await repos.managementBilling.update(actor.orgId, {
    checkedAt: new Date(),
    verified: {
      servers: 2,
      baseIncluded: false,
      priceCents: 500,
      status: "active",
      cancelAtPeriodEnd: false,
      periodEnd: new Date(Date.now() + 86_400_000).toISOString(),
    },
  });
  const create = (body: unknown = input) =>
    app.request("/api/system/servers", {
      method: "POST",
      headers: { ...actor.auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  return { actor, create };
}

it("serializes concurrent connections against one allowance and encrypts the saved credentials", async () => {
  const { actor, create } = await owner();
  const responses = await Promise.all(
    Array.from({ length: 3 }, (_, i) => create({ ...input, sshPort: 2200 + i })),
  );
  expect(responses.filter((response) => response.ok)).toHaveLength(2);
  expect(responses.filter((response) => response.status === 402)).toHaveLength(1);
  const servers = await repos.server.listByOrganization(actor.orgId, true);
  expect(servers).toHaveLength(2);
  for (const server of servers) {
    expect(server.sshPassword).toMatch(/^enc1:/);
    expect(server.sshHostKey).toBe(hostKey.toString("base64"));
  }
  for (const response of responses) expect(await response.text()).not.toContain(input.sshPassword);
});

it.each(["127.0.0.1", "169.254.169.254", "10.0.0.1", "::1"])(
  "never dials private Cloud-control-plane destination %s",
  async (sshHost) => {
    const { create } = await owner();
    expect((await create({ ...input, sshHost })).status).toBe(400);
    expect(network.create).not.toHaveBeenCalled();
  },
);

it("rechecks paid access before reusing a pooled SSH connection", async () => {
  const { actor, create } = await owner();
  expect((await create()).ok).toBe(true);
  const server = (await repos.server.listByOrganization(actor.orgId, true))[0]!;
  connections.push(server.id);
  await sshManager.acquire(server.id);
  const dials = network.create.mock.calls.length;
  await repos.managementBilling.update(actor.orgId, { checkedAt: new Date(), verified: null });
  await expect(sshManager.acquire(server.id)).rejects.toMatchObject({
    code: "MANAGEMENT_PLAN_REQUIRED",
  });
  expect(network.create.mock.calls).toHaveLength(dials);
  expect(await repos.server.get(server.id)).toBeDefined();
});
