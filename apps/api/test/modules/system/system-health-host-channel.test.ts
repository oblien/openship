import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Context } from "hono";

/**
 * `GET /api/system/health` must report whether this instance can drive its own host
 * (#509).
 *
 * The rollup is what `openship doctor` and external monitors call, and it had no
 * host-channel field at all — so on a containerized box whose channel was never
 * provisioned, install said success, this endpoint said healthy, and the first host
 * operation failed with text naming `openship doctor` as the way to check. The pinned
 * properties: the state is reported, the remedy comes with it, a broken channel does
 * NOT fail the rollup, and nothing secret rides along.
 */

const h = vi.hoisted(() => ({
  hostChannelHealth: vi.fn(async () => ({ ok: true, code: "ok" }) as unknown),
}));

vi.mock("@repo/adapters", () => ({ hostChannelHealth: h.hostChannelHealth }));

/** Array + `.where()`, so both `select().from()` and `select().from().where()` await
 *  into rows without pulling in drizzle. */
const rows = <T>(r: T[]) => Object.assign([...r], { where: () => r });

vi.mock("@repo/db", () => ({
  getDriver: () => "pglite",
  sql: (..._a: unknown[]) => ({}),
  count: () => ({}),
  eq: () => ({}),
  schema: { project: {}, service: {} },
  db: {
    execute: async () => rows([{ n: 42 }]),
    select: () => ({ from: () => rows([{ total: 3, apps: 1 }]) }),
  },
}));

const { systemHealth } = await import("../../../src/modules/system/system-health.controller");

interface HealthBody {
  ok: boolean;
  hostChannel: {
    ok: boolean;
    state: string;
    cause?: string;
    remedy?: string;
  } | null;
}

const call = async (): Promise<HealthBody> => {
  const body = await systemHealth({ json: (b: unknown) => b } as unknown as Context);
  return body as unknown as HealthBody;
};

beforeEach(() => {
  h.hostChannelHealth.mockReset();
  h.hostChannelHealth.mockResolvedValue({ ok: true, code: "ok" });
});

describe("GET /api/system/health — host channel", () => {
  it("reports a working channel with nothing to do about it", async () => {
    h.hostChannelHealth.mockResolvedValue({
      ok: true,
      code: "ok",
      host: "host.docker.internal",
      port: 22,
      target: "root@host.docker.internal:22",
    });
    const body = await call();
    expect(body.hostChannel).toEqual({ ok: true, state: "ok" });
  });

  it("reports a bare install as not applicable, not as a fault", async () => {
    h.hostChannelHealth.mockResolvedValue({ ok: true, code: "not_applicable" });
    expect((await call()).hostChannel).toEqual({ ok: true, state: "not_applicable" });
  });

  it("reports the #509 state with the repair AND the verification command", async () => {
    h.hostChannelHealth.mockResolvedValue({
      ok: false,
      code: "not_configured",
      hint:
        "Openship is running in a container with no host channel — OPENSHIP_HOST_SSH_HOST is " +
        "unset, so there is no address to reach the host at and nothing has been dialed. " +
        "Re-run `openship up` to provision the host channel. `openship doctor` reports whether it worked.",
    });
    const body = await call();
    expect(body.hostChannel?.ok).toBe(false);
    expect(body.hostChannel?.state).toBe("not_configured");
    // Both halves: the repair runs on the host and the fault is observed in a
    // container, so "did it work" is a separate question from "did it succeed".
    expect(body.hostChannel?.remedy).toContain("openship up");
    expect(body.hostChannel?.remedy).toContain("openship doctor");
  });

  it("does not fail the rollup — a channelless box is degraded, not down", async () => {
    h.hostChannelHealth.mockResolvedValue({ ok: false, code: "not_configured", hint: "x" });
    const body = await call();
    // `ok` means the database answers. Folding the channel in would send
    // `openship doctor --fix` at a database that is perfectly healthy.
    expect(body.ok).toBe(true);
  });

  it("classifies a failed dial by cause and carries no address or firewall rule", async () => {
    h.hostChannelHealth.mockResolvedValue({
      ok: false,
      code: "unreachable",
      host: "host.docker.internal",
      port: 22,
      target: "root@host.docker.internal:22",
      cause: "timeout",
      hint: "root@host.docker.internal:22 — no response, not even a refusal (ETIMEDOUT).",
      rule: "sudo ufw allow from 172.18.0.0/16 to any port 22 proto tcp",
    });
    const body = await call();
    expect(body.hostChannel?.state).toBe("unreachable");
    expect(body.hostChannel?.cause).toBe("timeout");
    // The rule is a block of pasteable commands for the surface an operator is
    // standing at (banner, doctor) — not for a monitoring payload.
    expect(JSON.stringify(body)).not.toContain("ufw");
    expect(Object.keys(body.hostChannel!).sort()).toEqual(["cause", "ok", "remedy", "state"]);
  });

  it("never puts the host key path on the wire", async () => {
    h.hostChannelHealth.mockResolvedValue({
      ok: false,
      code: "key_unreadable",
      host: "host.docker.internal",
      port: 22,
      target: "root@host.docker.internal:22",
      hint: "Cannot read the host SSH key at /var/lib/openship/ssh-keys/host_ed25519 (EACCES). Re-run `openship up` to reprovision it.",
    });
    const body = await call();
    expect(body.hostChannel?.state).toBe("key_unreadable");
    expect(JSON.stringify(body)).not.toContain("ssh-keys");
    // Still actionable: the remedy for an unreadable key is the same reprovision +
    // verify pair, which names no path.
    expect(body.hostChannel?.remedy).toContain("openship up");
    expect(body.hostChannel?.remedy).toContain("openship doctor");
  });

  it("reports the explicit opt-out as its own state", async () => {
    h.hostChannelHealth.mockResolvedValue({
      ok: false,
      code: "disabled",
      hint: "Host control is off (OPENSHIP_HOST_CONTROL=false). Re-run `openship up` without --no-host-control.",
    });
    const body = await call();
    expect(body.hostChannel?.state).toBe("disabled");
    expect(body.hostChannel?.ok).toBe(false);
    expect(body.hostChannel?.remedy).toContain("--no-host-control");
  });

  it("says nothing rather than blaming the host when the probe itself dies", async () => {
    h.hostChannelHealth.mockRejectedValue(new Error("probe exploded"));
    const body = await call();
    expect(body.hostChannel).toBeNull();
    expect(body.ok).toBe(true);
  });
});
