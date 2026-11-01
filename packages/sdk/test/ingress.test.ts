import { describe, expect, it, vi } from "vitest";
import { AppError, type IngressConnection } from "@repo/contracts";
import { createAuthorization, createPlatform } from "@repo/platform";
import { OpenshipClient } from "../src/client";
import { createShip } from "../src/native";
import { alice, authorizationFixture } from "../../platform/test/fixtures";
const connection: IngressConnection = {
  id: "igc_one",
  serverId: "server-a",
  credentialId: "cred_one",
  accountId: "account",
  tunnelId: "tunnel",
  name: "Tunnel",
  connector: "existing",
  edgePort: 80,
  managedTunnel: false,
  defaultForDomains: true,
  defaultAccessPolicyId: null,
  status: "ready",
  error: null,
};
const connectInput = {
  serverId: connection.serverId,
  credentialId: connection.credentialId,
  accountId: connection.accountId,
  tunnelId: connection.tunnelId!,
  name: connection.name,
  connector: connection.connector,
  defaultForDomains: true,
};
const discovery = {
  accounts: [{ id: "account", name: "Test" }],
  tunnels: [{ id: "tunnel", name: "Tunnel", remote: true, status: "healthy" }],
  policies: [],
  policiesError: null,
};
describe("managed ingress SDK transports", () => {
  it("uses the shared remote operations and omits path IDs from HTTP bodies", async () => {
    const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (url.includes("/domains/")) return Response.json(null);
      if (url.endsWith("/discover")) return Response.json(discovery);
      if (init.method === "DELETE") return Response.json({ success: true });
      if (init.method === "GET") return Response.json([connection]);
      return Response.json(connection);
    });
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: fetcher as typeof fetch,
    });
    expect(await client.dns.listIngressConnections({ serverId: "server-a" })).toEqual([connection]);
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
      "https://ship.test/api/dns/ingress?serverId=server-a",
    );
    await client.dns.discoverIngress({ credentialId: "cred_one", accountId: "account" });
    await client.dns.connectIngress(connectInput);
    await client.dns.updateIngress({
      id: "igc_one",
      defaultForDomains: false,
      defaultAccessPolicyId: null,
    });
    expect(fetcher.mock.calls.at(-1)).toMatchObject([
      "https://ship.test/api/dns/ingress/igc_one",
      {
        method: "PUT",
        body: JSON.stringify({ defaultForDomains: false, defaultAccessPolicyId: null }),
      },
    ]);
    await client.dns.retryIngress("igc_one");
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe("https://ship.test/api/dns/ingress/igc_one/retry");
    await client.dns.getDomainIngress({ domainId: "dom_one" });
    expect(fetcher.mock.calls.at(-1)?.[0]).toBe(
      "https://ship.test/api/dns/ingress/domains/dom_one",
    );
    await client.dns.setDomainIngress({
      domainId: "dom_one",
      connectionId: "igc_one",
      accessPolicyId: null,
    });
    expect(fetcher.mock.calls.at(-1)).toMatchObject([
      "https://ship.test/api/dns/ingress/domains/dom_one",
      { method: "PUT", body: JSON.stringify({ connectionId: "igc_one", accessPolicyId: null }) },
    ]);
    await client.dns.removeIngress("igc_one");
    expect(fetcher.mock.calls.at(-1)?.[1].method).toBe("DELETE");
  });
  it("rejects invalid settings before a request and redacts unexpected secret-bearing responses", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ ...connection, token: "must-not-leave-the-boundary" }),
    );
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: fetcher as typeof fetch,
    });
    await expect(client.dns.connectIngress({ ...connectInput, edgePort: 0 })).rejects.toThrow();
    await expect(
      client.dns.discoverIngress({ credentialId: "cred_one", accountId: "../../another-account" }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(client.dns.connectIngress(connectInput)).rejects.toMatchObject({
      status: 502,
      body: null,
    });
  });
  it("supports native calls with the same schemas and administrator gates", async () => {
    const state = authorizationFixture();
    state.members.set("org-a:alice", { id: "member-a", role: "owner" });
    const list = vi.fn(async () => [connection]),
      setDomain = vi.fn(async () => null),
      requireAdmin = vi.fn(async () => {});
    const platform = createPlatform({
      authorization: createAuthorization(state),
      trigger: vi.fn(),
      present: (row) => row as never,
      recordAudit: vi.fn(),
      forward: async () => null,
      dns: {
        requireAdmin,
        operations: { listIngressConnections: list, setDomainIngress: setDomain } as never,
      },
    });
    const ship = createShip({ platform, identity: { resolve: async () => alice } }),
      scope = await ship.scope({ identity: "verified", organizationId: "org-a" });
    expect(await scope.dns.listIngressConnections({ serverId: "server-a" })).toEqual([connection]);
    await scope.dns.setDomainIngress({ domainId: "domain-a", connectionId: null });
    expect(setDomain).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "alice", organizationId: "org-a", sessionKind: "native" }),
      { domainId: "domain-a", connectionId: null },
    );
    requireAdmin.mockRejectedValueOnce(
      new AppError("Requires admin role", 403, "INSUFFICIENT_ROLE"),
    );
    await expect(
      scope.dns.setDomainIngress({ domainId: "domain-a", connectionId: null }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_ROLE" });
    expect(setDomain).toHaveBeenCalledTimes(1);
  });
});
