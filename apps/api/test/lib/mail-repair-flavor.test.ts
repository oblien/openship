import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one-click "Fix" for a mail engine that isn't serving must work on BOTH
 * topologies. While the engine image is unpublished, every mail box in the field is
 * a LEGACY host-native install (systemd Postfix/Dovecot), so a repair that only knew
 * how to `docker start` was a dead end precisely where it was needed.
 *
 * These pin the branch and its safety contract: the flavor comes from the ONE
 * topology probe, a host box goes to `systemctl start` and a containerized one to
 * `docker start`, neither path can reach `ensureContainerMail` (whose first-boot
 * branch rewrites the secret env-files and would destroy a live mailbox), and an
 * inconclusive probe is reported as "couldn't look", never as "no mail here".
 */

vi.mock("@repo/adapters", () => ({
  dockerAvailable: vi.fn().mockResolvedValue(true),
  detectMailContainer: vi.fn().mockResolvedValue({ running: false, image: null, exists: false }),
  detectMailEngine: vi
    .fn()
    .mockResolvedValue({ flavor: "none", running: false, exists: false, image: null }),
  ensureContainerMail: vi.fn().mockResolvedValue({ updated: false }),
  startContainerMail: vi.fn().mockResolvedValue({ started: true }),
  startHostMail: vi.fn().mockResolvedValue({ started: true }),
}));

vi.mock("../../src/lib/mail-image", () => ({
  pinnedMailImage: vi.fn(() => "ghcr.io/oblien/openship-mail:0.5.0"),
  mailBuildSpec: vi.fn(() => undefined),
}));

import {
  dockerAvailable,
  detectMailEngine,
  ensureContainerMail,
  startContainerMail,
  startHostMail,
} from "@repo/adapters";
import { repairServerMail } from "../../src/lib/mail-reconcile";

const mocked = {
  docker: vi.mocked(dockerAvailable),
  engine: vi.mocked(detectMailEngine),
  ensure: vi.mocked(ensureContainerMail),
  startContainer: vi.mocked(startContainerMail),
  startHost: vi.mocked(startHostMail),
};

const executor = { exec: vi.fn() } as never;
const logs: string[] = [];
const onLog = (l: { message: string }) => void logs.push(l.message);

beforeEach(() => {
  vi.clearAllMocks();
  logs.length = 0;
  mocked.docker.mockResolvedValue(true);
  mocked.startContainer.mockResolvedValue({ started: true } as never);
  mocked.startHost.mockResolvedValue({ started: true } as never);
});

describe("repairServerMail", () => {
  it("starts the systemd units on a LEGACY host box, never the container path", async () => {
    mocked.engine.mockResolvedValue({
      flavor: "host",
      running: false,
      exists: true,
      image: null,
    } as never);

    const r = await repairServerMail(executor, { onLog });

    expect(r).toEqual({ started: true, mailDown: false });
    expect(mocked.startHost).toHaveBeenCalledWith(executor, expect.objectContaining({ onLog }));
    expect(mocked.startContainer).not.toHaveBeenCalled();
    expect(mocked.ensure).not.toHaveBeenCalled();
  });

  it("starts the containers on a containerized box", async () => {
    mocked.engine.mockResolvedValue({
      flavor: "container",
      running: false,
      exists: true,
      image: "ghcr.io/oblien/openship-mail:0.5.0",
    } as never);

    const r = await repairServerMail(executor, { onLog });

    expect(r).toEqual({ started: true, mailDown: false });
    expect(mocked.startContainer).toHaveBeenCalledWith(executor, expect.objectContaining({ onLog }));
    expect(mocked.startHost).not.toHaveBeenCalled();
    // The swap/first-boot path is never reachable from a repair — that's the whole
    // reason this helper exists instead of reusing the reconcile.
    expect(mocked.ensure).not.toHaveBeenCalled();
  });

  it("is a no-op on an engine that is already serving", async () => {
    mocked.engine.mockResolvedValue({
      flavor: "host",
      running: true,
      exists: true,
      image: null,
    } as never);

    const r = await repairServerMail(executor, { onLog });

    expect(r).toEqual({ started: false, mailDown: false });
    expect(mocked.startHost).not.toHaveBeenCalled();
    expect(mocked.startContainer).not.toHaveBeenCalled();
  });

  it("points at mail setup when the box genuinely has no engine", async () => {
    mocked.engine.mockResolvedValue({
      flavor: "none",
      running: false,
      exists: false,
      image: null,
    } as never);

    const r = await repairServerMail(executor, { onLog });

    expect(r.started).toBe(false);
    expect(r.mailDown).toBe(true);
    expect(r.reason).toMatch(/mail setup/i);
  });

  it("blames Docker, not mail setup, when the probe could not conclude", async () => {
    // With an unreachable daemon "no container" is a failed read. Telling the
    // operator to re-run mail setup there would point them at the wrong fix — and on
    // a live box, at the one path that rewrites secrets.
    mocked.engine.mockResolvedValue({
      flavor: "none",
      running: false,
      exists: false,
      image: null,
    } as never);
    mocked.docker.mockResolvedValue(false);

    const r = await repairServerMail(executor, { onLog });

    expect(r).toMatchObject({ started: false, mailDown: true });
    expect(r.reason).toMatch(/docker/i);
    expect(r.reason).not.toMatch(/mail setup/i);
  });

  it("reports a failed start as still down, with the helper's own reason", async () => {
    mocked.engine.mockResolvedValue({
      flavor: "host",
      running: false,
      exists: true,
      image: null,
    } as never);
    mocked.startHost.mockResolvedValue({
      started: false,
      reason: "postfix failed to bind :25",
    } as never);

    const r = await repairServerMail(executor, { onLog });

    expect(r).toMatchObject({ started: false, mailDown: true, reason: "postfix failed to bind :25" });
    expect(logs.join("\n")).toContain("postfix failed to bind :25");
  });

  it("never throws — a probe that blows up comes back as a reason", async () => {
    mocked.engine.mockRejectedValue(new Error("ssh channel closed") as never);
    mocked.docker.mockRejectedValue(new Error("ssh channel closed") as never);

    const r = await repairServerMail(executor, { onLog });
    expect(r).toMatchObject({ started: false, mailDown: true });
    expect(r.reason).toBeTruthy();
  });
});
