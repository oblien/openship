import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { withKeyedMutex } from "@repo/core";
import { MemoryCacheStore } from "@repo/platform/engine/lib/cache-store/memory";

const h = vi.hoisted(() => ({
  cloud: true,
  provider: "https://provider.example",
  denied: false,
  mint: vi.fn(),
  remote: vi.fn(),
}));
const stores = new Map<string, MemoryCacheStore<unknown>>();
vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloud;
    },
    get OBLIEN_API_URL() {
      return h.provider;
    },
    OBLIEN_CLIENT_ID: "account",
    OBLIEN_CLIENT_SECRET: "secret",
  },
  runtimeTarget: {},
}));
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({
  getOblienClient: () => ({ tokens: { create: h.mint } }),
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-scope", () => ({
  cloudBillingOwner: async (org: string, space: string) => {
    if (h.denied) throw new Error("workspace access denied");
    return { namespace: `${org}-${space}`, workspaceId: space, workspace: { id: space } };
  },
}));
vi.mock("@repo/platform/engine/modules/billing/billing-oblien-quota", () => ({
  assertNamespaceHasQuota: async () => {},
}));
vi.mock("@repo/platform/engine/lib/provision-lock", () => ({
  createProvisionLock: (key: string) => ({
    run: (work: () => Promise<unknown>) => withKeyedMutex(key, work),
  }),
}));
vi.mock("@repo/platform/engine/lib/cache-store/index", () => ({
  cacheStore: async (name: string) => {
    if (!stores.has(name)) stores.set(name, new MemoryCacheStore({ sweepIntervalMs: 0 }));
    return stores.get(name)!;
  },
}));
vi.mock("@repo/platform/engine/lib/cloud/server-connection", () => ({
  remoteServerConnection: h.remote,
}));
const { getNamespaceClient, issueNamespaceToken } =
  await import("@repo/platform/engine/lib/openship-cloud");

beforeEach(() => {
  stores.clear();
  h.cloud = true;
  h.denied = false;
  h.provider = "https://provider.example";
  h.mint.mockReset().mockImplementation(async () => ({
    token: `token-${h.mint.mock.calls.length}`,
    expiresAt: new Date(Date.now() + 1800_000).toISOString(),
  }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("shares internal token issuance across concurrent calls without bypassing workspace ownership", async () => {
  await Promise.all(Array.from({ length: 30 }, () => getNamespaceClient("org", "space")));
  expect(h.mint).toHaveBeenCalledTimes(1);
  h.denied = true;
  await expect(getNamespaceClient("org", "space")).rejects.toThrow("workspace access denied");
});

it("separates organizations, namespaces and provider destinations, and does not reuse externally issued tokens", async () => {
  await getNamespaceClient("org-a", "space");
  await getNamespaceClient("org-b", "space");
  await getNamespaceClient("org-a", "other");
  h.provider = "https://other.example";
  await getNamespaceClient("org-a", "space");
  expect(h.mint).toHaveBeenCalledTimes(4);
  await issueNamespaceToken("org-a", "space");
  await issueNamespaceToken("org-a", "space");
  expect(h.mint).toHaveBeenCalledTimes(6);
});

it("renews expiring credentials once across concurrent clients", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => Response.json({ success: true }));
  vi.stubGlobal("fetch", fetcher);
  const clients = await Promise.all([
    getNamespaceClient("org", "space"),
    getNamespaceClient("org", "space"),
  ]);
  vi.setSystemTime(Date.now() + 1741_000);
  await Promise.all(
    clients.map(({ client }) => client._http.request({ method: "GET", path: "/workspace" })),
  );
  expect(h.mint).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls).toHaveLength(2);
});

it("evicts rejected credentials without replaying a mutation", async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ code: "token_revoked" }, { status: 401 }))
    .mockImplementation(async () => Response.json({ success: true }));
  vi.stubGlobal("fetch", fetcher);
  const { client } = await getNamespaceClient("org", "space");
  await expect(client._http.request({ method: "POST", path: "/workspace" })).rejects.toMatchObject({
    status: 401,
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  const next = await getNamespaceClient("org", "space");
  await next.client._http.request({ method: "GET", path: "/workspace" });
  expect(h.mint).toHaveBeenCalledTimes(2);
  expect(new Headers(fetcher.mock.calls[1]![1].headers).get("authorization")).toBe(
    "Bearer token-2",
  );
});

it("replaces a shared token rejected by a real metrics stream on explicit reconnect", async () => {
  const authorizations: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    if (authorizations.length === 1) {
      response.writeHead(401);
      response.end();
    } else {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end('data: {"cpuUsage":7}\n\n');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test address");
    h.provider = `http://127.0.0.1:${address.port}`;
    const first = await getNamespaceClient("org", "space");
    await expect(
      first.client.streamWorkspaceMetrics("owned")[Symbol.asyncIterator]().next(),
    ).rejects.toThrow("Live resource usage is unavailable");
    expect(authorizations).toEqual(["Bearer token-1"]);
    expect(h.mint).toHaveBeenCalledTimes(1);
    const next = await getNamespaceClient("org", "space");
    for await (const sample of next.client.streamWorkspaceMetrics("owned")) {
      expect(sample).toEqual({ cpuUsage: 7 });
      break;
    }
    expect(authorizations).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(h.mint).toHaveBeenCalledTimes(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("does not evict a renewed token when an older request returns a late 401", async () => {
  vi.useFakeTimers();
  let rejectOld!: (response: Response) => void;
  const oldResponse = new Promise<Response>((resolve) => {
    rejectOld = resolve;
  });
  const fetcher = vi
    .fn()
    .mockImplementationOnce(() => oldResponse)
    .mockImplementation(async () => Response.json({ success: true }));
  vi.stubGlobal("fetch", fetcher);
  const { client } = await getNamespaceClient("org", "space");
  const old = client._http.request({ method: "POST", path: "/workspace" }).catch((error) => error);
  vi.setSystemTime(Date.now() + 1741_000);
  await client._http.request({ method: "GET", path: "/workspace" });
  rejectOld(Response.json({ code: "token_revoked" }, { status: 401 }));
  expect(await old).toMatchObject({ status: 401 });
  await getNamespaceClient("org", "space");
  expect(h.mint).toHaveBeenCalledTimes(2);
});

it("does not poison subsequent requests when issuance fails", async () => {
  h.mint.mockRejectedValueOnce(new Error("temporarily unavailable"));
  await expect(getNamespaceClient("org", "space")).rejects.toThrow("temporarily unavailable");
  await getNamespaceClient("org", "space");
  expect(h.mint).toHaveBeenCalledTimes(2);
});

it("keeps linked desktop credentials scoped to fresh remote connection authorization", async () => {
  h.cloud = false;
  h.remote.mockResolvedValue({
    token: "remote",
    namespace: "ns",
    providerApiUrl: h.provider,
    expiresAt: new Date(Date.now() + 1800_000).toISOString(),
  });
  await getNamespaceClient("org", "space");
  await getNamespaceClient("org", "space");
  expect(h.remote).toHaveBeenCalledTimes(2);
  expect(h.mint).not.toHaveBeenCalled();
});
