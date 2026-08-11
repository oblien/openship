import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * An update recreates the containers, which is exactly when a working container→host
 * SSH channel silently stops working — a new docker subnet the operator's firewall
 * rule doesn't cover, or a first-time channel provisioned by the version being
 * updated TO (#490). So `update` re-probes.
 *
 * What it must not do is print prose into `--json`: that output is consumed by the
 * install script and by anything scripting updates, and a chalk-coloured firewall
 * diagnosis in the middle of it is a parse error, not a warning.
 */

const h = vi.hoisted(() => ({
  json: vi.fn(() => false),
  verify: vi.fn(async () => ({ status: "ok" as const })),
}));

vi.mock("../../src/lib/output", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  isJsonMode: h.json,
}));

vi.mock("../../src/lib/host-channel-preflight", () => ({ verifyHostChannel: h.verify }));

const { verifyHostChannelAfterUpdate } = await import("../../src/commands/update");

beforeEach(() => {
  h.json.mockReset();
  h.json.mockReturnValue(false);
  h.verify.mockReset();
  h.verify.mockResolvedValue({ status: "ok" });
});

describe("verifyHostChannelAfterUpdate", () => {
  it("probes after a recreate", async () => {
    await verifyHostChannelAfterUpdate();
    expect(h.verify).toHaveBeenCalledTimes(1);
  });

  it("probes without asking to open the firewall", async () => {
    // The prompt belongs to `up`, where the operator is already installing. An update
    // is often unattended, and consent to edit the host firewall can't be assumed
    // from "update the stack".
    await verifyHostChannelAfterUpdate();
    expect(h.verify).toHaveBeenCalledWith();
  });

  it("stays silent under --json", async () => {
    h.json.mockReturnValue(true);
    await verifyHostChannelAfterUpdate();
    expect(h.verify).not.toHaveBeenCalled();
  });

  it("never fails the update", async () => {
    // The stack updated. A host-side extra being unreachable is a separate, reported
    // problem — not grounds for telling the operator the update failed.
    h.verify.mockRejectedValue(new Error("docker exec: no such service: api"));
    await expect(verifyHostChannelAfterUpdate()).resolves.toBeUndefined();
  });
});
