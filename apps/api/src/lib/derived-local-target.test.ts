import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A DERIVED `local` target and the `isLocal` "This Server" row are the SAME machine,
 * so they must resolve to the same executor.
 *
 * `local` is not a destination anyone picks — it is the absence of a binding (no
 * cloud workspace, no serverId), and `project.server_id` is ON DELETE SET NULL, so
 * deleting a server is enough to make the next deploy for that project derive it.
 * That branch used to take `createPlatform`'s default local executor, which inside
 * the api container runs host-side steps against the CONTAINER's filesystem — the
 * exact hazard `createHostExecutor` exists to refuse, reached through a second door.
 *
 * What's pinned here: that both doors take the ONE pooled host channel, that resolving
 * a target never REGISTERS one (creating a server row is preparation, not part of a
 * deploy), and that a dead channel refuses out loud at USE while the container workload
 * still deploys.
 */

const h = vi.hoisted(() => ({
  /** Every createPlatform config, in order. */
  configs: [] as Array<Record<string, unknown>>,
  /**
   * The pooled host channel. ONE object, handed back by both doors, because in
   * production they are one: `acquire(localRow)` resolves through
   * `acquireLocalHost` → `acquireHostChannel`, and the row id only adds the borrow
   * marker. A mock that returned two distinct executors would hide the very
   * convergence under test.
   */
  channel: { tag: "pooled-host-channel" } as unknown,
  acquire: vi.fn(async (_id: string) => h.channel),
  acquireHostChannel: vi.fn(async () => h.channel),
  /** The UNPOOLED idiom. Nothing here may reach it; #291 is what happens when it does. */
  hostExecutor: vi.fn((): unknown => ({ tag: "direct-host-executor" })),
  localRow: null as { id: string } | null,
  findCalls: 0,
  findRejects: false,
  ensureCalls: 0,
}));

vi.mock("@repo/adapters", async (importOriginal) => ({
  // Real `unavailableExecutor` / `HostChannelUnavailableError` / detection — the
  // degrade under test is theirs, and stubbing it would only assert the stub.
  ...(await importOriginal<Record<string, unknown>>()),
  createPlatform: async (config: Record<string, unknown>) => {
    h.configs.push(config);
    return { target: "selfhosted" };
  },
  createHostExecutor: () => h.hostExecutor(),
}));

vi.mock("./startup/self-server", () => ({
  findLocalServer: async () => {
    h.findCalls++;
    if (h.findRejects) throw new Error("db unavailable");
    return h.localRow;
  },
  // Mocked only so the "never on a resolve" assertion below can see a call if one
  // ever appears.
  ensureLocalServer: async () => {
    h.ensureCalls++;
    return h.localRow;
  },
}));

vi.mock("@repo/db", () => ({
  repos: {
    server: {
      getInOrganization: async (id: string) => ({
        id,
        isLocal: true,
        sshHost: "127.0.0.1",
        sshPort: 22,
        sshUser: "root",
      }),
      update: async () => {},
    },
  },
}));

// The row IS this box; keyed off the flag so the test doesn't depend on loopback
// resolution or env.
vi.mock("./box-org", () => ({
  isLocalHostRow: async (row: { isLocal?: boolean }) => Boolean(row?.isLocal),
}));

vi.mock("./ssh-manager", () => ({
  sshManager: { acquire: h.acquire, acquireHostChannel: h.acquireHostChannel },
  buildSshConfig: async () => ({ host: "127.0.0.1", port: 22, username: "root" }),
}));

vi.mock("./provision-lock", () => ({
  createProvisionLock: (name: string) => ({ name, run: (f: () => unknown) => f() }),
}));

const { resolveTargetPlatform } = await import("./deployment-runtime");
const { HostChannelUnavailableError } = await import("@repo/adapters");

const last = () => h.configs[h.configs.length - 1] as Record<string, unknown>;

beforeEach(() => {
  h.configs = [];
  h.localRow = null;
  h.findCalls = 0;
  h.findRejects = false;
  h.ensureCalls = 0;
  h.acquire.mockReset();
  h.acquire.mockImplementation(async () => h.channel);
  h.acquireHostChannel.mockReset();
  h.acquireHostChannel.mockImplementation(async () => h.channel);
  h.hostExecutor.mockReset();
  h.hostExecutor.mockImplementation(() => ({ tag: "direct-host-executor" }));
});

describe("derived local target — one machine, one executor path", () => {
  it("resolves THROUGH this box's isLocal row when it has one", async () => {
    h.localRow = { id: "srv-local" };
    await resolveTargetPlatform("local", "docker");

    // Pooled, keyed on the canonical row: that pool is what stops one deploy from
    // leaving an sshd session behind (#291), and it is the row's own id — never a
    // caller-supplied one, since the target already means "here".
    expect(h.acquire).toHaveBeenCalledWith("srv-local");
    expect(h.hostExecutor).not.toHaveBeenCalled();
    expect(last().executor).toBe(h.channel);
  });

  it("hands the platform the same executor a PICKED 'This Server' row does", async () => {
    h.localRow = { id: "srv-local" };
    await resolveTargetPlatform("server", "docker", "srv-local", "org1");
    const picked = last();
    await resolveTargetPlatform("local", "docker", undefined, "org1");
    const derived = last();

    // The whole point of the convergence: the wizard door and the no-binding door
    // cannot end up on different rules for the same box.
    expect(derived.executor).toBe(picked.executor);
    expect(derived.localHost).toBe(true);
    expect(derived.docker).toMatchObject({
      transport: "socket",
      resolveRegistryAuth: expect.any(Function),
    });
    expect(picked.docker).toMatchObject({
      transport: "socket",
      resolveRegistryAuth: expect.any(Function),
    });
    // Same host being provisioned → same lock, or two "local" deploys would race
    // openresty/docker/state on one machine.
    expect((derived.provisionLock as { name: string }).name).toBe(
      (picked.provisionLock as { name: string }).name,
    );
  });

  it("keeps the box as THIS machine, not a remote one", async () => {
    h.localRow = { id: "srv-local" };
    await resolveTargetPlatform("local", "docker");
    // `createPlatform` infers "this machine" from `localHost ?? !executor`, so an
    // injected executor without this reads as REMOTE — which switches off the
    // containerized edge provider and the same-path-mount rule for the local box.
    expect(last().localHost).toBe(true);
    expect(last().ssh).toBeUndefined();
    // The container workload still goes over the mounted socket, as before.
    expect(last().docker).toEqual({ transport: "socket" });
  });

  it("bare runtime asks for no docker transport at all", async () => {
    h.localRow = { id: "srv-local" };
    await resolveTargetPlatform("local", "bare");
    expect(last().docker).toBeUndefined();
    expect(last().localHost).toBe(true);
  });
});

describe("derived local target — boxes with no isLocal row", () => {
  it("takes the same pooled host channel, never an unpooled executor", async () => {
    // Desktop, the SaaS, and `--no-host-control` all legitimately have no row. The
    // row id is bookkeeping (the borrow marker); WHICH executor this box gets must
    // not depend on it, and it must never be a fresh `createHostExecutor()` outside
    // the pool, the concurrent-acquire dedup and the channel-health gate.
    await resolveTargetPlatform("local", "docker");
    expect(h.acquireHostChannel).toHaveBeenCalledTimes(1);
    expect(h.acquire).not.toHaveBeenCalled();
    expect(h.hostExecutor).not.toHaveBeenCalled();
    expect(last().executor).toBe(h.channel);
    expect(last().localHost).toBe(true);
  });

  it("a failed row lookup degrades to that same channel, it does not fail the deploy", async () => {
    h.findRejects = true;
    await resolveTargetPlatform("local", "docker");
    expect(h.acquireHostChannel).toHaveBeenCalledTimes(1);
    expect(last().executor).toBe(h.channel);
  });

  it("READS the row and never registers one", async () => {
    // Resolving a target is not preparation. Creating here would make a deploy
    // responsible for inserting a server row — and drag the creation path's
    // public-IP detection (an outbound request) onto a resolve that also runs for
    // plain runtime reads. `ensureLocalServer` belongs to boot and the
    // admin-establishing endpoints.
    await resolveTargetPlatform("local", "docker");
    await resolveTargetPlatform("local", "bare");
    expect(h.findCalls).toBe(2);
    expect(h.ensureCalls).toBe(0);
  });
});

describe("derived local target — a dead host channel", () => {
  it("still resolves, and refuses host operations at USE with the remedy", async () => {
    // The containerized-compose state: the resolve must survive (the workload is
    // reached through the mounted socket), and the host must be refused out loud
    // instead of quietly writing inside the api container.
    h.acquireHostChannel.mockRejectedValue(
      new HostChannelUnavailableError(
        "not_configured",
        "no host channel is configured. Re-run `openship up` to provision the host channel.",
      ),
    );
    const platform = await resolveTargetPlatform("local", "docker");
    expect(platform).toBeTruthy();

    const executor = last().executor as {
      exec: (cmd: string) => Promise<unknown>;
      exists: (p: string) => Promise<unknown>;
    };
    await expect(executor.exec("uname -a")).rejects.toThrow(/openship up/);
    // Not a silent `false`: an unproven answer that reads as fact is how a blocked
    // channel produced wrong work instead of a visible failure.
    await expect(executor.exists("/opt/openship")).rejects.toThrow(/no host channel/);
  });

  it("an AUTH failure is still a real failure, not a degrade", async () => {
    h.localRow = { id: "srv-local" };
    h.acquire.mockRejectedValue(new Error("All configured authentication methods failed"));
    await expect(resolveTargetPlatform("local", "docker")).rejects.toThrow(
      /authentication methods failed/,
    );
  });
});
