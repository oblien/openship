/**
 * One answer to "may I do root-owned work on this host, and through which executor?".
 *
 * Three layers asked this question and answered it differently: component installs
 * gated properly (`system/installer.ts`), toolchain installs never gated at all, and
 * the server state store assumed the login was root. The consequence was the same
 * every time — a non-root host got an EACCES from whatever ran first, attributed to
 * whatever step happened to surface it.
 *
 * The order matters and is the reason this is a function rather than a boolean: the
 * host verdict is checked BEFORE privilege, because privilege is the narrower question
 * and its message shadowed the real one on exactly the hosts this exists for. A
 * forced-command AMI cannot report a uid at all, so it reads as unprivileged and gets
 * told to "connect as root" — the opposite of the fix, which the resolver already knew.
 */

import { answered, refused, type Answer } from "@repo/core";

import type { CommandExecutor } from "../types";
import { elevatedExecutor } from "./elevated-executor";
import { resolveEnvironment, type EnvironmentProfile } from "./environment";
import { hostRefusal } from "./environment-ops";

declare const ROOT_CHECKED: unique symbol;

/**
 * An executor the privilege question has been ASKED about.
 *
 * Deliberately "checked", not "capable". A host Openship refuses to provision can still
 * be proceeded on (`onRefusedHost: "proceed"`), and if its login is neither root nor
 * sudo-capable the executor that comes back has no privilege at all. A brand promising
 * root would be a lie on that arm, and a brand that lies is worse than none: it makes
 * the reader stop checking. What this one promises is the thing that was actually
 * missing — that nobody walked past the gate. `Privileged.elevation` is how a caller
 * asks what it actually got.
 *
 * It exists because the failure it prevents is invisible. Routing gaps never fail a
 * deploy, so an unelevated edge executor produced a green deploy, an unreachable URL,
 * and no error anywhere; there was nothing for a test to catch, and code review had
 * already missed it once. Making the *type* of a routing executor unobtainable
 * without the gate turns the next occurrence into a compile error.
 */
export type RootChecked = CommandExecutor & { readonly [ROOT_CHECKED]: true };

/**
 * Brand an executor whose privilege was established some other way.
 *
 * The escape hatch, and it is meant to be conspicuous: `why` is unused at runtime and
 * exists only so it cannot be taken silently. Production callers are capped by
 * `host-command-ownership.test.ts` — adding one there is the review.
 *
 * If you are reaching for this because the gate refused, you want `rootOrDegrade`.
 */
export function rootChecked(executor: CommandExecutor, why: string): RootChecked {
  void why;
  return executor as RootChecked;
}

/**
 * How the returned executor got its privilege.
 *
 * `"none"` is reachable only on a refused host a caller chose to proceed on, and it is
 * the one outcome worth reporting: every write the caller is about to attempt against a
 * root-owned path will fail. Callers that degrade rather than throw have no other way to
 * tell "proceeded and fine" from "proceeded and doomed" — the executor is branded either
 * way, because the brand records that the gate was asked, not that it said yes.
 */
export type Elevation = "root" | "sudo" | "none";

export interface Privileged {
  /** The executor to run the privileged work through — elevated only if it had to be. */
  executor: RootChecked;
  /** The measured host, so callers don't re-probe to branch on distro/arch. */
  profile: EnvironmentProfile;
  elevation: Elevation;
}

export interface PrivilegeOptions {
  /**
   * What a host Openship has REFUSED means here — the one axis on which real callers
   * legitimately differ, so it is stated rather than defaulted silently. Covers both a
   * box we could not measure (a banner, a forced command) and one we measured and won't
   * drive (zypper, pacman, an unknown arch).
   *
   * `"refuse"` for work that must not be attempted blind: an install writes under /etc
   * and a wrong guess leaves a half-provisioned box.
   *
   * `"proceed"` for work that is merely root-OWNED file I/O, which needs no package
   * manager and no distro support. Attempting it is exactly what shipped before the
   * resolver existed, so a chatty banner must not turn a readable manifest into a
   * missing one — a refusal there is a regression dressed as a check.
   *
   * It decides whether to REFUSE, and nothing else. It used to also mean "and don't
   * elevate", which was the bug: sudo has nothing to do with whether we recognize the
   * distro, so an Arch box with a `deploy` user silently got an unprivileged executor
   * for root-owned paths — a `cat` of an unreadable file returns "", which `scan` reads
   * as "this server has no Openship state".
   */
  onRefusedHost?: "refuse" | "proceed";
}

/**
 * Total over the option, so a third answer is a compile error here rather than a silent
 * "refuse" — the direction that turns a new caller's intent into a dead deploy.
 */
const REFUSES_HOST: Record<NonNullable<PrivilegeOptions["onRefusedHost"]>, boolean> = {
  refuse: true,
  proceed: false,
};

/**
 * Resolve the host and pick the executor for root-owned work.
 *
 * `purpose` is rendered into the refusal, so pass the operator's noun ("Installing
 * docker", "Writing Openship server state") — this string is the whole diagnosis on a
 * host that cannot be provisioned.
 *
 * Elevation is NOT free of caveats and the choice is per-caller: `elevatedExecutor`'s
 * `writeFile` stages through `/tmp` and sudo-mv's, so writes into a root-only dir work,
 * but anything that must land in the *login user's* own space (a home-dir toolchain, a
 * journal the login user then executes) must NOT be run through this.
 */
export async function privilegedExecutor(
  executor: CommandExecutor,
  purpose: string,
  opts: PrivilegeOptions = {},
): Promise<Answer<Privileged>> {
  const profile = await resolveEnvironment(executor);

  const refusal = hostRefusal(profile);
  if (refusal && REFUSES_HOST[opts.onRefusedHost ?? "refuse"]) return refused(refusal);

  const grant = (elevation: Elevation, why: string, exec: CommandExecutor = executor) =>
    answered({ executor: rootChecked(exec, why), profile, elevation });

  // Deliberately AFTER the refusal check but on the same path for both kinds of host:
  // whether we recognize the distro has no bearing on whether sudo works, so a refused
  // host gets elevated by exactly the same rule a supported one does.
  if (profile.isRoot) return grant("root", "the login is root");
  if (profile.canSudo) {
    return grant("sudo", "non-root login with passwordless sudo", elevatedExecutor(executor));
  }

  // Only reachable when the caller asked to proceed: a supported host with no route to
  // root is the refusal below. An unmeasurable host lands here too — it reports neither
  // uid nor sudo — which is correct, and `rootOrDegrade` is what says so out loud.
  if (refusal) return grant("none", "caller chose to proceed unprivileged on a refused host");

  return refused(
    `${purpose} needs root. Connect this server as root, or as a user with passwordless sudo.`,
  );
}

/**
 * The gate for work that must not FAIL when it can't be elevated — routing and TLS.
 *
 * Routing gaps never fail a deploy: an app that builds and runs but isn't reachable is
 * a worse outcome than an app that's reachable on its port with no domain, so every
 * caller here degrades rather than refusing. That policy was previously re-derived at
 * each site, and re-derived means re-forgotten — all four routing entrypoints had
 * simply omitted it, which is how a `deploy@host` box reported a green deploy and
 * routed nothing.
 *
 * Three things are the same at every one of those sites and belong here: ask the gate,
 * accept an unmeasurable host as a degradation rather than an error (#490 — a probe
 * that throws during platform construction fails the deploy upstream of every
 * best-effort step), and SAY the reason. Only the consequence and where the reason
 * goes differ, so only those are parameters.
 */
export async function rootOrDegrade(
  executor: CommandExecutor,
  opts: {
    /** Operator's noun for the work, rendered into the refusal ("Configuring routing and TLS"). */
    purpose: string;
    /** What the operator loses when this degrades ("Routing may be incomplete..."). */
    consequence: string;
    /** Where the reason goes — a deploy log, a migration warning list, the server log. */
    report: (message: string) => void;
  },
): Promise<RootChecked> {
  const grant = await privilegedExecutor(executor, opts.purpose, {
    // A host we won't PROVISION we can still write files on — none of this installs
    // packages. Refusing here would take a working edge away from an openSUSE box.
    onRefusedHost: "proceed",
  }).catch((err: unknown) => {
    // Naming the work is the whole value of this line: the operator is reading a warning
    // about a host that answered nothing, and "could not measure privileges" alone doesn't
    // say which step is about to be degraded.
    opts.report(
      `${opts.purpose}: could not check this host's privileges ` +
        `(${err instanceof Error ? err.message : String(err)}). ${opts.consequence}`,
    );
    return null;
  });
  if (!grant) return rootChecked(executor, "host unmeasurable; reported and degraded");
  if (!grant.supported) {
    opts.report(`${grant.reason} ${opts.consequence}`);
    return rootChecked(executor, "gate refused the host; reported and degraded");
  }

  // Report on the OUTCOME, not on which arm produced it. Proceeding on a refused host is
  // fine when the login is root and silently broken when it isn't, and only the second is
  // worth an operator's attention — reporting the arm would warn about every openSUSE
  // deploy that then worked perfectly, which is how a warning stops being read.
  if (grant.value.elevation === "none") {
    opts.report(
      `${opts.purpose} needs root, and this host's login is neither root nor able to ` +
        `sudo. ${opts.consequence}`,
    );
  }
  return grant.value.executor;
}
