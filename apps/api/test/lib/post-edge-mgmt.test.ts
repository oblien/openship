import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * `postEdgeMgmt` is the ONE way in to an edge's mgmt API.
 *
 * The thing these tests exist to prevent: it used to `fetch("http://127.0.0.1:9145")` when
 * `serverId` was null, on the theory that "local" means the API can reach the edge on its
 * own loopback. On the shape we ship, the API and the edge are SEPARATE CONTAINERS — so
 * that address is the API container itself, and the push either hit nothing or, on a
 * control plane that also runs an edge, configured the wrong box. It failed silently,
 * because the call was already `.catch()`-ed.
 *
 * "Local" is a SERVER ROW ("This Server"), not a transport. Resolving it means every edge
 * is reached the same way, and the only loopback in play is the one inside the edge
 * container, which `mgmtRequest` already owns.
 */

/**
 * The tunnel is faked one layer DOWN, at `ssh-tunnel`, not by spying on `postMgmtJson`.
 *
 * Spying on the module namespace does not intercept a call `postEdgeMgmt` makes to a
 * module-local binding — which is exactly what silently broke the route-rules push tests
 * when this seam was introduced, so it is worth not repeating here.
 */
const { tunnelRequest } = vi.hoisted(() => ({ tunnelRequest: vi.fn() }));

vi.mock("../../src/lib/ssh-tunnel", () => ({
  tunnelRequest,
  tunnelStream: vi.fn(),
}));
vi.mock("../../src/lib/ssh-manager", () => ({
  sshManager: { retain: vi.fn(), release: vi.fn(), acquire: vi.fn() },
}));
vi.mock("../../src/lib/platform-mode", () => ({ isOblienBackedDeployment: async () => false }));
const { findLocal } = vi.hoisted(() => ({ findLocal: vi.fn() }));
vi.mock("@repo/db", () => ({
  repos: {
    server: { findById: async () => ({ id: "srv1" }), findLocal },
  },
}));

const { postEdgeMgmt } = await import("../../src/lib/project-analytics");

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("where a push goes", () => {
  it("NEVER fetches loopback from the API process", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    findLocal.mockResolvedValue({ id: "local-srv" });
    tunnelRequest.mockResolvedValue({ statusCode: 200, body: "{}" });

    await postEdgeMgmt(null, "/analytics/config", { hosts: [] }, "org1");

    // The regression this guards: 127.0.0.1 inside the API container is the API container.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("resolves a null serverId to the This Server row and goes through it", async () => {
    findLocal.mockResolvedValue({ id: "local-srv" });
    tunnelRequest.mockResolvedValue({ statusCode: 200, body: "{}" });

    await postEdgeMgmt(null, "/analytics/config", { hosts: [] }, "org1");

    expect(findLocal).toHaveBeenCalledWith("org1");
    // Same transport as any other server: `sshManager.acquire` hands back the pooled host
    // channel for a local row, so there is exactly one code path to reach an edge.
    expect(tunnelRequest).toHaveBeenCalledTimes(1);
    expect((tunnelRequest.mock.calls[0] as unknown as [string])[0]).toBe("local-srv");
  });

  it("does nothing when there is no local row — this box is not a deploy target", async () => {
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    findLocal.mockResolvedValue(undefined);

    await postEdgeMgmt(null, "/rules", { host: "a.com", rules: [] }, "org1");

    // Host control off, or the SaaS control plane. Doing nothing is correct; guessing at
    // loopback is how the wrong edge gets configured.
    expect(tunnelRequest).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when no org was passed to resolve local with", async () => {
    await postEdgeMgmt(null, "/rules", { host: "a.com", rules: [] });
    expect(findLocal).not.toHaveBeenCalled();
    expect(tunnelRequest).not.toHaveBeenCalled();
  });

  it("goes through the tunnel for a managed server, never loopback", async () => {
    tunnelRequest.mockResolvedValue({ statusCode: 200, body: "{}" });
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);

    await postEdgeMgmt("srv1", "/rules", { host: "a.com", rules: [] });

    // Loopback here would reach the CONTROL PLANE's own edge and apply another box's
    // config locally — the worst possible failure for a multi-server install.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(tunnelRequest).toHaveBeenCalledTimes(1);
    const [serverId, port, path, init] = tunnelRequest.mock.calls[0] as unknown as [
      string, number, string, { method?: string; body?: string },
    ];
    expect(serverId).toBe("srv1");
    expect(port).toBe(9145);
    expect(path).toBe("/rules");
    expect(JSON.parse(String(init.body))).toEqual({ host: "a.com", rules: [] });
  });
});

describe("failure is best-effort by contract", () => {
  it("resolves when the local row cannot be read", async () => {
    findLocal.mockRejectedValue(new Error("db down"));
    // The database is the source of truth and every caller re-pushes on route apply, so a
    // failed push costs freshness until the next apply, never correctness. Throwing here
    // would abort a routing reconcile over a metrics setting.
    await expect(
      postEdgeMgmt(null, "/analytics/config", { hosts: [] }, "org1"),
    ).resolves.toBeUndefined();
  });

  it("resolves when the tunnel fails", async () => {
    tunnelRequest.mockRejectedValue(new Error("tunnel closed"));
    await expect(
      postEdgeMgmt("srv1", "/analytics/config", { host: "a.com", paths: true }),
    ).resolves.toBeUndefined();
  });
});
