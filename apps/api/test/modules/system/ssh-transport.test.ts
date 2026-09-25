import { afterEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { repos } from "@repo/db";
import { connOk } from "@repo/core";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient } from "@repo/sdk/client";
import { seedOwner } from "../jobs/_harness";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { buildSshConfig, sshManager } from "@repo/platform/engine/lib/ssh-manager";
import * as connectivity from "@repo/platform/engine/lib/connectivity";
import { serverManagementRoutes } from "../../../src/modules/system/server-management.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { healthRoutes } from "../../../src/modules/health/health.routes";

const app = new Hono().onError(handleApiError).route("/api/health", healthRoutes).route("/api/system", serverManagementRoutes);

async function clients() {
  const owner = await seedOwner();
  const user = (await repos.user.findById(owner.userId))!;
  const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user: { id: user.id, email: user.email, name: user.name }, sessionId: "ssh-transport-test" }) } });
  const native = (await ship.scope({ identity: "verified", organizationId: owner.orgId })).servers;
  const remote = new OpenshipClient({ baseUrl: "http://openship.test", token: owner.token, organizationId: owner.orgId, fetch: ((url, init) => app.request(url as string, init)) as typeof fetch }).servers;
  return { native, remote, owner };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("saved Cloudflare SSH through HTTP and native SDK", () => {
  it("persists, reads, edits and resets the transport while preserving encrypted credentials", async () => {
    const { native, remote } = await clients();
    for (const [writer, reader] of [[native, remote], [remote, native]]) {
      const server = await writer!.create({ name: "Cloudflare server", sshHost: `${crypto.randomUUID()}.example.test`, sshTransport: "cloudflare", sshAuthMethod: "password", sshPassword: "server-password" });
      expect(server.sshTransport).toBe("cloudflare");
      expect(server).not.toHaveProperty("sshPassword");
      expect(await reader!.get(server.id)).toMatchObject({ sshTransport: "cloudflare" });
      const row = (await repos.server.get(server.id))!;
      expect(row.sshPassword).toMatch(/^enc1:/);
      expect(await buildSshConfig(row)).toMatchObject({ sshTransport: "cloudflare", password: "server-password" });
      await writer!.update(server.id, { name: "Renamed" });
      expect(await reader!.get(server.id)).toMatchObject({ name: "Renamed", sshTransport: "cloudflare" });
      await writer!.update(server.id, { sshTransport: "direct" });
      expect(await reader!.get(server.id)).toMatchObject({ sshTransport: "direct" });
      expect((await repos.server.get(server.id))!.sshPassword).toBe(row.sshPassword);
    }
  });

  it("uses the same Cloudflare configuration for ephemeral tests in both transports", async () => {
    const check = vi.spyOn(connectivity, "runConnectivityCheck").mockResolvedValue(connOk(1));
    const { native, remote } = await clients();
    for (const client of [native, remote]) {
      await client.testConnection({ sshHost: "ssh.example.test", sshTransport: "cloudflare", sshAuthMethod: "password", sshPassword: "explicit-password" });
      expect(check).toHaveBeenLastCalledWith("ssh", expect.objectContaining({ host: "ssh.example.test", sshTransport: "cloudflare", password: "explicit-password" }));
    }
  });

  it("rejects arbitrary commands, invalid hostnames and conflicting routes before saving", async () => {
    const { native, remote, owner } = await clients();
    const before = (await repos.server.listByOrganization(owner.orgId)).length;
    for (const client of [native, remote]) {
      await expect(client.create({ sshHost: "ssh.example.test", sshTransport: "cloudflare", sshJumpHost: "bastion.example.test" })).rejects.toThrow(/either/);
      await expect(client.create({ sshHost: "127.0.0.1", sshTransport: "cloudflare" })).rejects.toThrow(/hostname/);
      await expect(client.create({ sshHost: "ssh.example.test", sshTransport: "cloudflare", sshArgs: "-oProxyCommand=id" })).rejects.toThrow(/Unsupported SSH option/);
    }
    const response = await app.request("/api/system/servers", { method: "POST", headers: { ...owner.auth, "Content-Type": "application/json" }, body: JSON.stringify({ sshHost: "ssh.example.test", sshProxyCommand: "id" }) });
    expect(response.status).toBe(400);
    expect((await repos.server.listByOrganization(owner.orgId)).length).toBe(before);
  });

  it("keeps Cloudflare servers organization-scoped", async () => {
    const first = await clients();
    const second = await clients();
    const server = await first.remote.create({ sshHost: "ssh.example.test", sshTransport: "cloudflare" });
    for (const client of [second.native, second.remote]) {
      await expect(client.get(server.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(client.update(server.id, { sshTransport: "direct" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it("requires the native host-execution capability for the Cloudflare client", async () => {
    const { native } = await clients();
    vi.stubEnv("OPENSHIP_NATIVE", "true");
    vi.stubEnv("OPENSHIP_NATIVE_ALLOW_HOST_EXECUTION", "false");
    await expect(native.create({ sshHost: "ssh.example.test", sshTransport: "cloudflare", sshAuthMethod: "password", sshPassword: "password" })).rejects.toMatchObject({ code: "HOST_EXECUTION_DISABLED" });
  });

  it("checks saved Cloudflare reachability through SSH instead of the public SSH port", async () => {
    const { native } = await clients();
    const server = await native.create({ sshHost: "ssh.example.test", sshTransport: "cloudflare", sshAuthMethod: "password", sshPassword: "password" });
    const exec = vi.fn().mockResolvedValue("");
    const use = vi.spyOn(sshManager, "withExecutor").mockImplementation(async (_id, fn) => fn({ exec } as never));
    expect(await sshManager.diagnoseReachability(server.id)).toEqual({ reachable: true, code: "ok" });
    expect(use).toHaveBeenCalledWith(server.id, expect.any(Function));
    expect(exec).toHaveBeenCalledWith("true", { timeout: 2500 });
  });
});
