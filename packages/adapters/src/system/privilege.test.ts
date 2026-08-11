import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CommandExecutor } from "../types";
import { OS_RELEASE, answeredProbe, unansweredProbe, type ProbeSpec } from "./environment.fixtures";

/**
 * The gate every root-owned write goes through, and it had no test.
 *
 * What makes that expensive is the shape of the failure: the two callers that pass
 * `onRefusedHost` both write to root-owned paths and both DEGRADE rather than throw, so a
 * gate that hands back an unprivileged executor produces a green deploy, an unreachable
 * URL or an empty manifest, and no error anywhere. There is nothing for another test to
 * catch downstream — the wrong answer here is indistinguishable from an empty box.
 *
 * These pin the decision, not the mechanics. `elevatedExecutor` is mocked to a sentinel
 * because whether privilege.ts CHOOSES to wrap is the question; how the wrapper stages a
 * write through /tmp is `elevated-executor.test.ts`'s.
 */

const ELEVATED = { id: "elevated" } as unknown as CommandExecutor;
const PLAIN = { id: "plain" } as unknown as CommandExecutor;

const h = vi.hoisted(() => ({
  resolveEnvironment: vi.fn(),
  elevatedExecutor: vi.fn(),
}));

vi.mock("./environment", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./environment")>()),
  resolveEnvironment: h.resolveEnvironment,
}));

vi.mock("./elevated-executor", () => ({ elevatedExecutor: h.elevatedExecutor }));

import { parseEnvironmentProbe } from "./environment";
import { privilegedExecutor, rootOrDegrade } from "./privilege";

/** A host the real parser built from what the real script would print. */
function host(spec: ProbeSpec) {
  return parseEnvironmentProbe(answeredProbe(spec));
}

const NON_ROOT: ProbeSpec = { uid: "1000", user: "deploy", home: "/home/deploy" };

const HOSTS = {
  /** Supported, root login. The 99% case. */
  ubuntuRoot: host({}),
  ubuntuSudo: host({ ...NON_ROOT, sudo: "y" }),
  ubuntuStuck: host({ ...NON_ROOT, sudo: "n" }),
  /** Recognized and REFUSED — no pacman provisioning path. Sudo still works fine here. */
  archSudo: host({ ...NON_ROOT, sudo: "y", osRelease: OS_RELEASE.arch }),
  archRoot: host({ osRelease: OS_RELEASE.arch }),
  archStuck: host({ ...NON_ROOT, sudo: "n", osRelease: OS_RELEASE.arch }),
  /** Answered something other than our keys — the AWS forced-command AMI. */
  intercepted: parseEnvironmentProbe(unansweredProbe('Please login as the user "ec2-user"')),
};

beforeEach(() => {
  h.resolveEnvironment.mockReset();
  h.elevatedExecutor.mockReset().mockReturnValue(ELEVATED);
});

/** Point the gate at a host. */
function on(profile: unknown) {
  h.resolveEnvironment.mockResolvedValue(profile);
}

describe("privilegedExecutor", () => {
  it("uses the login executor untouched when the login is root", async () => {
    on(HOSTS.ubuntuRoot);

    const grant = await privilegedExecutor(PLAIN, "Installing docker");

    expect(grant.supported).toBe(true);
    if (!grant.supported) return;
    expect(grant.value.elevation).toBe("root");
    expect(grant.value.executor).toBe(PLAIN);
    expect(h.elevatedExecutor).not.toHaveBeenCalled();
  });

  it("elevates a non-root login that can sudo", async () => {
    on(HOSTS.ubuntuSudo);

    const grant = await privilegedExecutor(PLAIN, "Installing docker");

    expect(grant.supported).toBe(true);
    if (!grant.supported) return;
    expect(grant.value.elevation).toBe("sudo");
    expect(grant.value.executor).toBe(ELEVATED);
  });

  it("refuses a login with no route to root, naming the work", async () => {
    on(HOSTS.ubuntuStuck);

    const grant = await privilegedExecutor(PLAIN, "Installing docker");

    expect(grant.supported).toBe(false);
    if (grant.supported) return;
    expect(grant.reason).toContain("Installing docker");
    expect(grant.reason).toContain("passwordless sudo");
  });

  it("refuses a host it cannot drive, by default, with the host's own reason", async () => {
    on(HOSTS.archSudo);

    const grant = await privilegedExecutor(PLAIN, "Installing docker");

    expect(grant.supported).toBe(false);
    if (grant.supported) return;
    // The distro reason, not "needs root" — privilege is the narrower question and its
    // message shadowed the real one on exactly the hosts this ordering exists for.
    expect(grant.reason).toContain("pacman");
  });

  /**
   * THE REGRESSION. `onRefusedHost` decides whether to refuse and nothing else.
   *
   * It used to mean "and don't elevate either", so a `deploy@arch-box` got a plain
   * unprivileged executor for `/etc/openresty` and `/root/.openship`. Sudo has nothing to
   * do with whether we recognize the distro, and conflating the two resurrected the
   * `deploy@host` bug on every host outside the allowlist — silently, because both
   * callers degrade rather than throw.
   */
  it("still elevates on a host it won't provision — sudo doesn't depend on the distro", async () => {
    on(HOSTS.archSudo);

    const grant = await privilegedExecutor(PLAIN, "Writing Openship server state", {
      onRefusedHost: "proceed",
    });

    expect(grant.supported).toBe(true);
    if (!grant.supported) return;
    expect(grant.value.elevation).toBe("sudo");
    expect(grant.value.executor).toBe(ELEVATED);
  });

  it("proceeds unelevated only when there is genuinely no route to root", async () => {
    on(HOSTS.archStuck);

    const grant = await privilegedExecutor(PLAIN, "Writing Openship server state", {
      onRefusedHost: "proceed",
    });

    // Answered, not refused: attempting the write is what shipped before the resolver
    // existed, and a chatty banner must not turn a readable manifest into a missing one.
    expect(grant.supported).toBe(true);
    if (!grant.supported) return;
    expect(grant.value.elevation).toBe("none");
    expect(grant.value.executor).toBe(PLAIN);
  });

  it("reports `none` for a host that answered something other than the probe", async () => {
    on(HOSTS.intercepted);

    const grant = await privilegedExecutor(PLAIN, "Configuring routing", {
      onRefusedHost: "proceed",
    });

    // It reported neither uid nor sudo, so there is no claim to make about privilege.
    expect(grant.supported).toBe(true);
    if (!grant.supported) return;
    expect(grant.value.elevation).toBe("none");
  });

  it("hands back the measured host so callers don't re-probe", async () => {
    on(HOSTS.ubuntuRoot);

    const grant = await privilegedExecutor(PLAIN, "Installing docker");

    expect(grant.supported).toBe(true);
    if (!grant.supported) return;
    expect(grant.value.profile.distro).toBe("ubuntu");
  });
});

describe("rootOrDegrade", () => {
  const opts = (report: (m: string) => void) => ({
    purpose: "Writing migrated vhosts",
    consequence: "Migrated vhosts and certificates may not be writable.",
    report,
  });

  it("says nothing on a root host", async () => {
    on(HOSTS.ubuntuRoot);
    const report = vi.fn();

    await expect(rootOrDegrade(PLAIN, opts(report))).resolves.toBe(PLAIN);
    expect(report).not.toHaveBeenCalled();
  });

  /**
   * The reason the warning is keyed on the OUTCOME rather than on which arm produced it.
   * Warning here would fire on every openSUSE/Arch deploy that then worked perfectly,
   * and a warning that cries wolf on a working deploy is how the real one stops being read.
   */
  it("says nothing when it proceeded on a refused host and got sudo anyway", async () => {
    on(HOSTS.archSudo);
    const report = vi.fn();

    await expect(rootOrDegrade(PLAIN, opts(report))).resolves.toBe(ELEVATED);
    expect(report).not.toHaveBeenCalled();
  });

  it("warns exactly once, naming the work and the loss, when it has no privilege", async () => {
    on(HOSTS.archStuck);
    const report = vi.fn();

    // Degrades rather than throwing: routing gaps must never fail a deploy, because an
    // app reachable on its port with no domain beats an app that didn't deploy.
    await expect(rootOrDegrade(PLAIN, opts(report))).resolves.toBe(PLAIN);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toContain("Writing migrated vhosts");
    expect(report.mock.calls[0]?.[0]).toContain("may not be writable");
  });

  it("warns with the gate's reason when the gate refuses outright", async () => {
    on(HOSTS.ubuntuStuck);
    const report = vi.fn();

    await expect(rootOrDegrade(PLAIN, opts(report))).resolves.toBe(PLAIN);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0]?.[0]).toContain("needs root");
    expect(report.mock.calls[0]?.[0]).toContain("may not be writable");
  });

  /**
   * #490: the probe throwing during platform construction failed the deploy upstream of
   * every best-effort step, so a host-channel firewall drop took the whole deploy with it
   * rather than costing it a domain.
   */
  it("degrades instead of throwing when the host can't be measured at all", async () => {
    h.resolveEnvironment.mockRejectedValue(new Error("socket hang up"));
    const report = vi.fn();

    await expect(rootOrDegrade(PLAIN, opts(report))).resolves.toBe(PLAIN);
    expect(report).toHaveBeenCalledTimes(1);
    // Both halves matter: the operator needs to know which step degraded AND what the
    // host actually said. The purpose used to be dropped on this arm only — the one arm
    // where there is no other information to go on.
    expect(report.mock.calls[0]?.[0]).toContain("Writing migrated vhosts");
    expect(report.mock.calls[0]?.[0]).toContain("socket hang up");
  });
});
