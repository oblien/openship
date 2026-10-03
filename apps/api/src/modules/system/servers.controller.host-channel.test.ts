import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecutionContext, PermissionInput } from "@repo/platform";

const h = vi.hoisted(() => ({
  authorize: vi.fn(async (ctx: ExecutionContext, _input: PermissionInput) => ctx),
  diagnose: vi.fn(),
  local: true,
}));

vi.mock("@repo/db", () => {
  const row = () => ({
    id: "srv1", name: "This Server", isLocal: h.local, sshHost: "127.0.0.1",
    sshPort: 22, sshUser: "root", sshAuthMethod: "key", sshKeyPath: null,
    sshPrivateKey: "encrypted-private-key", sshPassword: "encrypted-password",
    sshKeyPassphrase: "encrypted-passphrase", sshJumpHost: null, sshArgs: null,
    createdAt: new Date("2026-09-24T00:00:00Z"),
  });
  return { repos: {
    server: {
      listByOrganization: vi.fn(async () => [row()]),
      getInOrganization: vi.fn(async () => row()),
    },
    project: { countActiveByServer: vi.fn(async () => ({ srv1: 1 })) },
  } };
});
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<Record<string, unknown>>()), hostControlDisabled: () => false,
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", () => ({
  sshManager: { diagnoseReachability: h.diagnose },
}));
vi.mock("@repo/platform/engine/lib/startup/self-server", async (original) => ({
  ...(await original<Record<string, unknown>>()), ensureLocalServer: vi.fn(async () => null),
}));
vi.mock("@repo/platform/engine/lib/geo-ip", async (original) => ({
  ...(await original<Record<string, unknown>>()), primeGeo: vi.fn(async () => {}),
}));
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  authorization: { authorize: h.authorize, checkPermissionOnResource: vi.fn(async () => true) },
}));
vi.mock("../../lib/operation-context", () => ({
  operationContext: () => ({ userId: "u1", organizationId: "org1", role: "owner" }),
  operationData: async (_c: unknown, work: Promise<{ data: unknown }>) => (await work).data,
}));
vi.mock("@repo/platform/engine/lib/platform", async () => {
  const { createServerOperations } = await import("@repo/platform");
  const { serverDependencies } = await import("@repo/platform/engine/modules/system/server.operations");
  const { authorization } = await import("@repo/platform/engine/lib/authorization");
  return { getPlatformKernel: () => ({ servers: createServerOperations(authorization, serverDependencies) }) };
});

import { getServer, listServers, probeReachability } from "./servers.controller";

// Exercise the HTTP controller through the real engine operation and its output
// validation. Mocking the host-channel helper to null hid this failure in the
// existing server tests; only the external diagnosis/storage are replaced here.
const app = new Hono()
  .get("/servers", listServers)
  .get("/servers/:id", getServer)
  .get("/servers/:id/reachability", probeReachability);
app.onError((error, c) => c.json({ error: error.message }, 500));

beforeEach(() => {
  vi.clearAllMocks();
  h.local = true;
  h.authorize.mockImplementation(async (ctx) => ctx);
  h.diagnose.mockResolvedValue({ reachable: true, code: "ok", channel: "ok" });
});

const channels = [
  { channel: "ok", ok: true },
  { channel: "not_applicable", ok: true },
  { channel: "disabled", ok: false, hint: "Host control is off." },
  { channel: "not_configured", ok: false, hint: "Provision the host channel." },
  { channel: "key_unreadable", ok: false, hint: "Check the host key file." },
  { channel: "unreachable", ok: false, hint: "Check the firewall." },
  { channel: "auth_rejected", ok: false, hint: "Reauthorize the host key." },
];

describe.each(["/servers", "/servers/srv1", "/servers/srv1/reachability"])("GET %s", (path) => {
  const reachability = path.endsWith("/reachability");
  const rowFrom = (body: unknown) => (Array.isArray(body) ? body[0] : body) as Record<string, unknown>;

  it.each(channels)("accepts the real $channel diagnosis without changing its public shape", async ({ channel, ok, hint }) => {
    h.diagnose.mockResolvedValue({ reachable: ok, code: ok ? "ok" : "host_channel_blocked", channel, hint });

    const response = await app.request(path);
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    const row = rowFrom(body);
    if (reachability) {
      expect(row).toMatchObject({ channel, hint: hint ?? null });
    } else {
      expect(row).toMatchObject({
        hostChannel: { ok, channel, hint: hint ?? null },
        country: null, projectCount: 1, createdAt: "2026-09-24T00:00:00.000Z",
      });
      expect(row).not.toHaveProperty("sshPrivateKey");
      expect(row).not.toHaveProperty("sshPassword");
      expect(row).not.toHaveProperty("sshKeyPassphrase");
    }
    expect(h.authorize).toHaveBeenCalled();
  });

  it("keeps a remote server without a local host-channel annotation readable", async () => {
    h.local = false;
    h.diagnose.mockResolvedValue({ reachable: true, code: "ok" });
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(rowFrom(await response.json())).toHaveProperty(reachability ? "channel" : "hostChannel", null);
  });

  it("keeps a failed diagnosis from breaking the server response", async () => {
    h.diagnose.mockRejectedValue(new Error("probe unavailable"));
    const response = await app.request(path);
    expect(response.status).toBe(200);
    expect(rowFrom(await response.json())).toHaveProperty(reachability ? "channel" : "hostChannel", null);
  });

  it("does not probe a server before authorization", async () => {
    h.authorize.mockRejectedValue(new Error("forbidden"));
    await app.request(path);
    expect(h.diagnose).not.toHaveBeenCalled();
  });
});
