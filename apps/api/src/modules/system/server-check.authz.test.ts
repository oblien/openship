import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * `POST /system/check` — what happens BEFORE the connection diagnosis.
 *
 * The host-channel diagnosis (#490) answers a failed check with the address the
 * container actually dials, plus the firewall rule for it. That is the right answer
 * for an operator and the wrong one for everybody else, so what's pinned here is who
 * can reach it: the permission failure and the malformed request must both terminate
 * ahead of the catch, and only a TRANSPORT failure may spend a probe.
 */

const h = vi.hoisted(() => ({
  assert: vi.fn(async () => {}),
  withExecutor: vi.fn(async (_id: string, _fn: unknown) => [] as unknown),
  diagnose: vi.fn(async () => ({
    reachable: false,
    code: "host_channel_blocked" as const,
    target: "root@host.docker.internal:22",
    hint: "no response, not even a refusal (ETIMEDOUT).",
    rule: "sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp",
  })),
}));

vi.mock("@repo/db", () => ({
  repos: {
    server: {
      get: vi.fn(async () => undefined),
      getInOrganization: vi.fn(async () => null),
      list: vi.fn(async () => []),
    },
    member: { find: vi.fn(async () => null) },
    serverContainer: { list: vi.fn(async () => []) },
  },
}));

// The real module, minus its singleton: `isTransportFailure` is the gate on the
// diagnosis and a stand-in for it would keep passing after the two stopped agreeing.
vi.mock("../../lib/ssh-manager", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sshManager: { withExecutor: h.withExecutor, diagnoseReachability: h.diagnose },
}));

vi.mock("../../lib/permission", () => ({ permission: { assert: h.assert } }));
vi.mock("../../lib/request-context", () => ({
  getRequestContext: () => ({ userId: "u1", organizationId: "org1", role: "member" }),
}));

import { checkServer } from "./server-check.controller";

/** Enough of a Hono context for this handler: a JSON body in, a JSON reply out. */
function context(body: unknown) {
  const sent: { body: unknown; status: number } = { body: undefined, status: 0 };
  const c = {
    req: { json: async () => body },
    json: (payload: unknown, status = 200) => {
      sent.body = payload;
      sent.status = status;
      return payload as never;
    },
  };
  return { c: c as never, sent };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.assert.mockImplementation(async () => {});
});

describe("checkServer — the gate runs before the diagnosis", () => {
  it("lets a permission failure through untouched instead of answering it with the host channel", async () => {
    // `permission.assert` throws NotFoundError for a row the caller may not see, which
    // the error handler renders as a 404. Caught by this handler it fell into the
    // connection diagnosis and came back 502 with the channel's real target and rule —
    // an unauthorized caller reading the host's SSH endpoint off a failed authz check.
    const denied = Object.assign(new Error("Server not found"), { status: 404 });
    h.assert.mockRejectedValueOnce(denied);

    const { c, sent } = context({ serverId: "s-not-mine" });
    await expect(checkServer(c)).rejects.toBe(denied);

    expect(sent.status).toBe(0);
    expect(h.diagnose).not.toHaveBeenCalled();
    expect(h.withExecutor).not.toHaveBeenCalled();
  });

  it("checks the caller before it dials anything", async () => {
    const { c } = context({ serverId: "s1" });
    await checkServer(c);
    expect(h.assert).toHaveBeenCalledWith(expect.anything(), {
      resourceType: "server",
      resourceId: "s1",
      action: "admin",
    });
    expect(h.assert.mock.invocationCallOrder[0]!).toBeLessThan(
      h.withExecutor.mock.invocationCallOrder[0]!,
    );
  });

  it("rejects a non-array component list as a bad request, not a broken server", async () => {
    // It also used to throw on `.filter` INSIDE the try and land as a 502 about a
    // server that was answering fine.
    const { c, sent } = context({ serverId: "s1", components: "docker" });
    await checkServer(c);
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ error: "components must be an array" });
    expect(h.withExecutor).not.toHaveBeenCalled();
    expect(h.diagnose).not.toHaveBeenCalled();
  });

  it("rejects a list of unknown component names without dialing", async () => {
    const { c, sent } = context({ serverId: "s1", components: ["rm -rf /"] });
    await checkServer(c);
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ error: "Invalid component names" });
    expect(h.withExecutor).not.toHaveBeenCalled();
  });
});

describe("checkServer — only a transport failure earns a diagnosis", () => {
  it("hands the UI the dialed address and the rule when the transport died", async () => {
    h.withExecutor.mockRejectedValueOnce(new Error("Connection timed out after 30000ms"));

    const { c, sent } = context({ serverId: "s1" });
    await checkServer(c);

    expect(sent.status).toBe(502);
    expect(sent.body).toMatchObject({
      error: "host_channel_blocked",
      code: "host_channel_blocked",
      target: "root@host.docker.internal:22",
      rule: "sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp",
    });
  });

  it("spends no probe on a failure the transport had nothing to do with", async () => {
    // A component check that threw for its own reasons is not evidence about the
    // channel, and diagnosing it anyway tells the operator about a firewall that was
    // never involved.
    h.withExecutor.mockRejectedValueOnce(new Error("unexpected output from dpkg-query"));

    const { c, sent } = context({ serverId: "s1" });
    await checkServer(c);

    expect(h.diagnose).not.toHaveBeenCalled();
    expect(sent.status).toBe(502);
    expect(sent.body).toMatchObject({ error: "connection_failed" });
  });

  it("does not dress every host-channel error up as a firewall", async () => {
    const { HostChannelUnavailableError } = await import("@repo/adapters");
    h.withExecutor.mockRejectedValueOnce(
      new HostChannelUnavailableError("disabled", "Host control is off on this instance."),
    );
    // A disabled channel is an operator choice, not a blocked one — the diagnosis says
    // so, and the reply must stay the generic failure rather than borrow the remedy.
    h.diagnose.mockResolvedValueOnce({ reachable: false, code: "disabled" } as never);

    const { c, sent } = context({ serverId: "s1" });
    await checkServer(c);

    expect(h.diagnose).toHaveBeenCalledWith("s1");
    expect(sent.status).toBe(502);
    expect(sent.body).toMatchObject({ error: "connection_failed" });
    expect(sent.body).not.toHaveProperty("rule");
  });
});
