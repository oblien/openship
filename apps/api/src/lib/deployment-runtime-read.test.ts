import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * `resolveDeploymentRuntimeForRead` must reach the SAME host a deploy would, while
 * skipping the platform build (SystemManager + the infra provider whose
 * OpenResty detect / Lua self-heal runs under the provision lock — the thing that
 * made polled service status time out and report "unknown").
 *
 * These cases exist because a first cut of this resolver re-derived the target
 * itself (`meta.serverId ? server : local`) and got two of them wrong:
 *   • selfhosted `deployTarget:"server"` with NO recorded serverId — a real state
 *     (resolveEffectiveTarget:169) — resolved to the ORCHESTRATOR's socket, i.e.
 *     it would have reported container state from the wrong machine.
 *   • desktop with no `deployTarget` defaults to CLOUD, and that fell through to
 *     the laptop's docker socket.
 * So the assertion here is about which host is chosen, not just that it's fast.
 */

const h = vi.hoisted(() => ({
  baseTarget: "selfhosted" as "selfhosted" | "desktop" | "cloud",
  /** Every DockerRuntime.create — transport plus, for ssh, the host it dialed. */
  creates: [] as Array<{ transport: string; host?: string }>,
  platformCalls: 0,
}));

vi.mock("@repo/adapters", () => ({
  DockerRuntime: {
    create: async (opts: { transport: string; host?: string }) => {
      h.creates.push({ transport: opts?.transport, host: opts?.host });
      return { name: "docker", supports: () => true };
    },
  },
  createHostExecutor: () => ({}),
  createPlatform: async () => {
    // Standing in for the expensive build this resolver exists to avoid: if a
    // read path ever reaches it for an on-box target, the count catches it.
    h.platformCalls++;
    return { target: "selfhosted", runtime: { name: "platform-runtime" } };
  },
}));

vi.mock("./controller-helpers", () => ({
  platform: () => ({ target: h.baseTarget, runtime: { name: "docker" } }),
}));

vi.mock("./ssh-manager", () => ({
  sshManager: { acquire: async () => ({}) },
  // Echo the server's host so the ssh transport reveals WHICH server was picked.
  buildSshConfig: async (server: { sshHost: string }) => ({
    host: server.sshHost,
    port: 22,
    username: "root",
  }),
}));

vi.mock("./provision-lock", () => ({ createProvisionLock: () => ({ run: (f: () => unknown) => f() }) }));
vi.mock("./cloud/client", () => ({ cloudClient: {}, getOrgCloudToken: async () => null }));
vi.mock("./cloud/transport", () => ({ resolveOrgCloudUserId: async () => null }));
vi.mock("@repo/db", () => ({
  repos: {
    server: {
      getInOrganization: async (id: string) => ({ id, isLocal: false, sshHost: `host-of-${id}`, sshPort: 22, sshUser: "root" }),
      listByOrganization: async () => [
        { id: "only-server", isLocal: false, sshHost: "host-of-only-server", sshPort: 22, sshUser: "root" },
      ],
    },
  },
}));

const mod = await import("./deployment-runtime");

const read = (meta: Record<string, unknown>) =>
  mod.resolveDeploymentRuntimeForRead({ meta, organizationId: "org1" } as never);

/** Hosts dialed over the ssh transport, in order. */
const sshHosts = () => h.creates.filter((c) => c.transport === "ssh").map((c) => c.host);
const socketCalls = () => h.creates.filter((c) => c.transport === "socket").length;

beforeEach(() => {
  h.baseTarget = "selfhosted";
  h.creates = [];
  h.platformCalls = 0;
});

describe("resolveDeploymentRuntimeForRead — reaches the deploy's host, without the platform", () => {
  it("server target → the pinned server's docker, never the local socket", async () => {
    await read({ deployTarget: "server", serverId: "srv-9" });
    expect(sshHosts()).toEqual(["host-of-srv-9"]);
    expect(socketCalls()).toBe(0);
    expect(h.platformCalls).toBe(0);
  });

  it("REGRESSION: server target with NO serverId still goes to the server resolver", async () => {
    // resolveServerExecutor falls back to the org's single server; short-circuiting
    // to the socket here would read containers off the orchestrator instead.
    await read({ deployTarget: "server" });
    expect(sshHosts()).toEqual(["host-of-only-server"]);
    expect(socketCalls()).toBe(0);
  });

  it("a recorded serverId wins even when deployTarget says otherwise", async () => {
    await read({ deployTarget: "local", serverId: "srv-3" });
    expect(sshHosts()).toEqual(["host-of-srv-3"]);
  });

  it("local target → the host socket, and never builds a platform", async () => {
    await read({ deployTarget: "local" });
    expect(socketCalls()).toBe(1);
    expect(sshHosts()).toEqual([]);
    expect(h.platformCalls).toBe(0);
  });

  it("selfhosted with no target at all → local socket", async () => {
    await read({});
    expect(socketCalls()).toBe(1);
    expect(h.platformCalls).toBe(0);
  });

  it("REGRESSION: desktop with no deployTarget is CLOUD, not the laptop's socket", async () => {
    h.baseTarget = "desktop";
    // Cloud delegates to the platform path (its runtime is an Oblien HTTP client —
    // no executor, no OpenResty, nothing to skip). With no cloud link that
    // resolution REJECTS, and it must be allowed to: the service read wraps this
    // in a catch → "unknown", which is the honest answer for an unlinked box.
    // What matters here is that it never silently reads the laptop's docker.
    await expect(read({})).rejects.toThrow();
    expect(socketCalls()).toBe(0);
    expect(sshHosts()).toEqual([]);
  });

  it("desktop pinned to a server still goes over SSH to that server", async () => {
    h.baseTarget = "desktop";
    await read({ serverId: "srv-remote" });
    expect(sshHosts()).toEqual(["host-of-srv-remote"]);
    expect(h.platformCalls).toBe(0);
  });
});
