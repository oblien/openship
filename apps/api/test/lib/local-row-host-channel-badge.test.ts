import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The local row is advertised as a deploy target with no reference to channel health
 * (#509).
 *
 * `ensureLocalServer` and the servers list gate on ONE thing: the explicit
 * `--no-host-control` opt-out. That is right for the row's EXISTENCE — a container
 * workload is reached through the mounted Docker socket, so hiding the row on a box
 * whose channel was never provisioned would break deploys that never needed it. What
 * was missing is a WARNING: the wizard kept offering "This Server" and the first
 * host-side step failed mid-deploy with no earlier signal.
 *
 * So the row carries the channel's state as an annotation. These pin the two things
 * that make the annotation trustworthy: it agrees with the row's own reachability
 * endpoint (one diagnosis, not a second probe), and it never labels a box it has no
 * evidence about.
 */

const diagnoseReachability = vi.hoisted(() => vi.fn());

vi.mock("../../src/lib/ssh-manager", () => ({ sshManager: { diagnoseReachability } }));
vi.mock("@repo/db", () => ({ repos: { server: {} } }));
vi.mock("../../src/lib/box-org", () => ({ boxOwningOrgId: async () => "org_1" }));
vi.mock("../../src/lib/server-target", () => ({ resolveInstancePublicIp: async () => null }));

const { localServerHostChannel } = await import("../../src/lib/startup/self-server");

beforeEach(() => {
  diagnoseReachability.mockReset();
});

describe("localServerHostChannel", () => {
  it("reports the #509 state with the remedy attached", async () => {
    diagnoseReachability.mockResolvedValue({
      reachable: false,
      code: "host_channel_blocked",
      channel: "not_configured",
      hint: "Re-run `openship up` to provision the host channel. `openship doctor` reports whether it worked.",
    });
    expect(await localServerHostChannel("srv-local")).toEqual({
      ok: false,
      channel: "not_configured",
      hint: expect.stringContaining("openship up"),
    });
  });

  it("separates 'the row deploys' from 'host steps run' for the opt-out", async () => {
    // `disabled` is deliberately REACHABLE — the row's containers deploy over the
    // Docker socket — while every host-side step refuses. Reading `reachable` here
    // would badge a box whose host operations are all dead as fully healthy.
    diagnoseReachability.mockResolvedValue({
      reachable: true,
      code: "host_control_disabled",
      channel: "disabled",
      hint: "Host control is off (OPENSHIP_HOST_CONTROL=false).",
    });
    const health = await localServerHostChannel("srv-local");
    expect(health?.ok).toBe(false);
    expect(health?.channel).toBe("disabled");
  });

  it("reports a firewalled channel with the rule's own hint", async () => {
    diagnoseReachability.mockResolvedValue({
      reachable: false,
      code: "host_channel_blocked",
      channel: "unreachable",
      target: "root@host.docker.internal:22",
      hint: "root@host.docker.internal:22 — no response, not even a refusal.",
    });
    const health = await localServerHostChannel("srv-local");
    expect(health).toMatchObject({ ok: false, channel: "unreachable" });
    expect(health?.hint).toContain("host.docker.internal");
  });

  it("says a working channel is working, bare install included", async () => {
    diagnoseReachability.mockResolvedValue({ reachable: true, code: "ok", channel: "ok" });
    expect(await localServerHostChannel("srv-local")).toEqual({
      ok: true,
      channel: "ok",
      hint: null,
    });
    // Bare: LocalExecutor IS the host, so there is nothing to dial and nothing wrong.
    diagnoseReachability.mockResolvedValue({
      reachable: true,
      code: "ok",
      channel: "not_applicable",
    });
    expect(await localServerHostChannel("srv-local")).toMatchObject({
      ok: true,
      channel: "not_applicable",
    });
  });

  it("says nothing about a remote row, which has no channel of ours", async () => {
    // Safe to call for every row in a list: a remote box must never be labelled with
    // THIS box's channel state.
    diagnoseReachability.mockResolvedValue({
      reachable: false,
      code: "unreachable",
      target: "root@203.0.113.9:22",
    });
    expect(await localServerHostChannel("srv-remote")).toBeNull();
  });

  it("says nothing when the diagnosis itself fails", async () => {
    diagnoseReachability.mockRejectedValue(new Error("manager destroyed"));
    expect(await localServerHostChannel("srv-local")).toBeNull();
  });
});
