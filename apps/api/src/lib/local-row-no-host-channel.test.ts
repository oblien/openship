import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A local server row's WORKLOAD is reached through the mounted Docker socket, so a
 * box that cannot drive its host must still resolve a deploy target (#490).
 *
 * The old behaviour threw at RESOLVE time, because `createHostExecutor()` throws at
 * construction. That made switching host control off — the very remedy printed for a
 * firewall-blocked channel — kill every deploy to "This Server", and the two failures
 * looked nothing alike. The property pinned here: resolve succeeds, and the host is
 * refused at USE, with the reason intact.
 */

const h = vi.hoisted(() => ({
  acquire: vi.fn(async (_id: string) => ({ tag: "real-host-channel" }) as unknown),
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
  sshManager: { acquire: h.acquire },
  buildSshConfig: async () => ({ host: "127.0.0.1", port: 22, username: "root" }),
}));

vi.mock("./provision-lock", () => ({
  createProvisionLock: () => ({ run: (f: () => unknown) => f() }),
}));

const { resolvePlannedTargetTopology, resolveServerExecutor, hostChannelDeployNotice } =
  await import("./deployment-runtime");
const { HostChannelUnavailableError } = await import("@repo/adapters");

const resolve = () => resolveServerExecutor("srv-local", "org1");

beforeEach(() => {
  h.acquire.mockReset();
  h.acquire.mockImplementation(async () => ({ tag: "real-host-channel" }));
});

describe("resolveServerExecutor — local row with no host channel", () => {
  it("plans socket Docker source without acquiring a host command channel", async () => {
    await expect(
      resolvePlannedTargetTopology("server", "srv-local", "org1"),
    ).resolves.toEqual({ serverId: "srv-local", dockerTransport: "socket" });
    expect(h.acquire).not.toHaveBeenCalled();
  });

  it("still resolves when host control is switched off", async () => {
    h.acquire.mockRejectedValue(
      new HostChannelUnavailableError("disabled", "Host control is disabled on this instance."),
    );
    const resolved = await resolve();
    expect(resolved.isLocal).toBe(true);
    expect(resolved.ssh).toBeNull();
  });

  it("refuses host operations at use, carrying the remedy", async () => {
    h.acquire.mockRejectedValue(
      new HostChannelUnavailableError(
        "disabled",
        "Host control is disabled on this instance (OPENSHIP_HOST_CONTROL=false).",
      ),
    );
    const { executor } = await resolve();
    await expect(executor.exec("uname -a")).rejects.toThrow(/OPENSHIP_HOST_CONTROL=false/);
    // Not a silent `false`: an unproven answer that reads as fact is how a blocked
    // channel produced wrong work instead of a visible failure.
    await expect(executor.exists("/opt/openship")).rejects.toThrow(/Host control is disabled/);
  });

  it("still resolves when containerized with no channel provisioned", async () => {
    h.acquire.mockRejectedValue(
      new HostChannelUnavailableError("not_configured", "no host channel is configured"),
    );
    const { executor } = await resolve();
    await expect(executor.exec("ls")).rejects.toThrow(/no host channel is configured/);
  });

  it("still resolves when the channel is provisioned and the host firewall drops it", async () => {
    // The state #490 actually reported. The workload here is reached through the
    // mounted Docker socket, so failing the resolve would take down every container
    // deploy to "This Server" over a channel those deploys never touch.
    h.acquire.mockRejectedValue(
      new HostChannelUnavailableError(
        "unreachable",
        "Nothing came back from root@host.docker.internal:22 — allow it with: " +
          "sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp",
      ),
    );
    const resolved = await resolve();
    expect(resolved.isLocal).toBe(true);
    // A host-side step still refuses — with the rule, immediately, instead of a bare
    // handshake timeout per operation.
    await expect(resolved.executor.exec("uname -a")).rejects.toThrow(/sudo ufw allow from/);
  });

  it("an AUTH failure is still a real failure, not a degrade", async () => {
    // The degrade above is specific to "this box can't drive its host". A key the host
    // rejects is a different fault with a different fix, and swallowing it would
    // recreate #490's actual problem: the deploy proceeds and fails somewhere unrelated.
    h.acquire.mockRejectedValue(new Error("All configured authentication methods failed"));
    await expect(resolve()).rejects.toThrow(/authentication methods failed/);
  });

  it("passes the pooled host channel through untouched when it works", async () => {
    const { executor } = await resolve();
    expect(executor).toEqual({ tag: "real-host-channel" });
  });
});

/**
 * The demotion above is the moment we decide this box cannot drive its host, and it
 * used to leave no trace at all: the typed error was swallowed and an executor that
 * refuses everything was handed back in silence. #509 is what that costs — install
 * reported success, the box looked healthy, and the operator's first evidence arrived
 * as an unrelated-looking failure inside a deploy.
 *
 * So the decision is announced twice, at the two altitudes that have a reader: the
 * process log (here) and the deploy log (below).
 */
describe("the demotion leaves a trace", () => {
  it("logs the decision with the remedy, ONCE per outage", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.acquire.mockRejectedValue(
      new HostChannelUnavailableError(
        "not_configured",
        "no host channel is configured. Re-run `openship up` to provision the host channel.",
      ),
    );
    await resolve();
    await resolve();
    await resolve();
    // Once — this sits on every deploy AND on read paths (logs, status polls), so a
    // line per resolve would bury the log it is meant to be found in.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("openship up");
    expect(warn.mock.calls[0]?.[0]).toContain("not_configured");
    warn.mockRestore();
  });

  it("re-arms after the channel recovers, so the next outage is not deduped away", async () => {
    const reason = "the firewall dropped it — sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp";
    h.acquire.mockRejectedValue(new HostChannelUnavailableError("unreachable", reason));
    await resolve();

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.acquire.mockImplementation(async () => ({ tag: "real-host-channel" }));
    await resolve();
    h.acquire.mockRejectedValue(new HostChannelUnavailableError("unreachable", reason));
    await resolve();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("hostChannelDeployNotice", () => {
  it("gives a deploy log one line naming the skip, the reason and the reassurance", async () => {
    h.acquire.mockRejectedValue(
      new HostChannelUnavailableError(
        "not_configured",
        "no host channel is configured. Re-run `openship up` to provision the host channel.",
      ),
    );
    const { executor } = await resolve();
    const notice = hostChannelDeployNotice(executor);
    // Named, so the operator connects it to the "couldn't read occupancy" and
    // "deploy continues" lines that follow — those name neither the channel nor a fix.
    expect(notice).toContain("port-occupancy");
    expect(notice).toContain("edge/routing");
    expect(notice).toContain("openship up");
    // Straight from @repo/core: this is a degraded install, not a broken one, and the
    // deploy in progress is going to succeed.
    expect(notice).toContain("Ordinary deploys to this box still work");
  });

  it("says nothing about a channel nothing has decided anything about", async () => {
    const { executor } = await resolve();
    // A working pooled channel, and the no-executor case (cloud) — neither is
    // evidence of a demotion, and a notice printed on either is a lie about the box.
    expect(hostChannelDeployNotice(executor)).toBeNull();
    expect(hostChannelDeployNotice(null)).toBeNull();
    expect(hostChannelDeployNotice(undefined)).toBeNull();
  });
});
