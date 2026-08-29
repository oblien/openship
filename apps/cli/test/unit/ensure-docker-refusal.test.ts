import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `ensureDocker` must SAY why it isn't installing Docker.
 *
 * `dockerInstallPreview` answers a refusal with a reason — the distro or arch the
 * install plan will not touch, or a box with no init we recognise. `wizard.ts` prints
 * that reason on the preview path; the MUTATING path dropped it and returned a bare
 * `false`, so `up` fell back to the process service in silence. That is the same
 * refusal-read-as-absence the host resolver exists to end, one layer up: the operator
 * saw "using the bare service" and had nothing to search for.
 *
 * `startBlockedReason` was worse — produced by `dockerInstallPreview` and consumed by
 * nothing at all, so an install that SUCCEEDED and then couldn't start reported only
 * the generic "Docker still isn't usable" re-probe line.
 */

const h = vi.hoisted(() => ({
  /** What `systemCatalog.installs.docker(profile)` answers. */
  plan: null as unknown,
  /** Exit code the mocked `spawn` (the installer) reports. */
  installExit: 0,
}));

vi.mock("node:child_process", () => ({
  // Every probe fails: `docker --version` non-zero is `binary: false`, which is the
  // one dockerGap arm that is `installable` and does NOT consult `thisHost()`.
  spawnSync: vi.fn(() => ({ status: 1 })),
  spawn: vi.fn(() => ({
    on: (event: string, cb: (code?: number) => void) => {
      if (event === "close") setTimeout(() => cb(h.installExit), 0);
    },
  })),
}));

vi.mock("@repo/adapters", async () => ({
  ...(await import("../helpers/harness")).dockerSocketMock,
  systemCatalog: { installs: { docker: () => h.plan } },
  resolveLocalEnvironmentSync: () => ({ os: "linux", distro: "alpine", isRoot: true }),
  LocalExecutor: class {},
  EDGE_CONTAINER_MOUNTS: [],
  EDGE_HOST_STATE_DIR: "/tmp/openship-edge",
  invalidateEdgeContainer: () => {},
}));
vi.mock("@repo/adapters/proxy", () => ({ sanitizeEdgeVhosts: () => {} }));
// Never reached on the `binary: false` arm, and stubbed so the real one can't probe.
vi.mock("../../src/lib/this-host", () => ({
  pasteable: () => null,
  thisHost: () => ({ dockerStart: () => null, profile: { isRoot: true }, sshdEnableHint: () => null }),
}));

import { ensureDocker } from "../../src/lib/compose";

const realPlatform = process.platform;
const setPlatform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { value, configurable: true });

beforeEach(() => {
  h.installExit = 0;
  setPlatform("linux");
});
afterEach(() => setPlatform(realPlatform));

/** Run it and collect what the operator would have seen. */
async function run(): Promise<{ ok: boolean; said: string }> {
  const lines: string[] = [];
  const ok = await ensureDocker({ onNotice: (l) => lines.push(l) });
  return { ok, said: lines.join("\n") };
}

describe("ensureDocker surfaces a refusal", () => {
  it("names the host the install plan refused", async () => {
    h.plan = { supported: false, reason: "openSUSE Leap installs Docker with zypper, which Openship does not drive" };

    const { ok, said } = await run();

    expect(ok).toBe(false);
    expect(said).toContain("zypper");
  });

  it("names why a successful install could not be started", async () => {
    h.plan = {
      supported: true,
      value: {
        installCommand: "apk add docker",
        // The install works; starting it does not, because this box has no init.
        service: { supported: false, reason: "no service manager Openship recognizes on alpine" },
      },
    };

    const { ok, said } = await run();

    expect(ok).toBe(false);
    expect(said).toContain("no service manager Openship recognizes");
  });

  it("stays quiet when the plan is fine and only the daemon check fails", async () => {
    // The contrast case: a supported plan with a start command has no refusal to
    // report, so neither reason may appear. Without this, a fix that printed
    // unconditionally would still pass the two tests above.
    h.plan = {
      supported: true,
      value: { installCommand: "apk add docker", service: { supported: true, value: "rc-service docker start" } },
    };

    const { said } = await run();

    expect(said).not.toContain("zypper");
    expect(said).not.toContain("no service manager");
  });
});
