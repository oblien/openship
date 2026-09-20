/**
 * Mail-server health checks.
 *
 * One catalog of daemons, probed over whichever engine the box runs: the
 * `openship-mail` container (supervisord programs + a pg sidecar) or a legacy
 * host-native install (systemd units). The probe COMMAND and its parsing are the
 * only difference and both live in `./mail-engine.ts`; this file resolves the
 * topology once per request and stays flavor-blind. That's deliberate — the
 * container-only rewrite is what made a legacy box report nine "unknown" rows.
 *
 * `unit` is the supervisord PROGRAM name inside the engine image, kept identical
 * to the legacy systemd unit name so ONE catalog serves both flavors; PostgreSQL
 * is the one special case (a sidecar container vs the host's `postgresql` unit).
 */

import type { CommandExecutor } from "@repo/adapters";
import { safeErrorMessage } from "@repo/core";

import {
  mailUnitProbeCommand,
  parseMailUnitProbe,
  resolveMailEngine,
  type MailEngineFlavor,
  type MailUnitStatus,
} from "./mail-engine";

/**
 * Does a mail server stop being a mail server without this daemon?
 *
 *  - `required` — Postfix / Dovecot / PostgreSQL. Nothing is delivered without them.
 *  - `advisory` — the filtering and hardening daemons. Their absence degrades the
 *    box; it does not stop it being one.
 *
 * ONE definition, read by both the install gate (`stepDeployEngine`) and the Health
 * banner, so the two cannot disagree about which daemon is load-bearing.
 */
/**
 * How much a component's state says about whether this box is a working mail server.
 *
 *   required      — down means mail has stopped. Red.
 *   advisory      — mail still flows, with reduced protection. Amber.
 *   informational — reported for completeness; NOTHING depends on it, so its state must
 *                   never colour the banner (GH-240). Distinct from "advisory" on
 *                   purpose: amber for a daemon no part of the stack consults teaches
 *                   operators to ignore the banner, which is worse than not showing it.
 */
export type MailComponentSeverity = "required" | "advisory" | "informational";

/** Components we check. `unit` is the supervisord program name in the engine image. */
export interface MailComponentDef {
  /** Stable id - used by the frontend as a React key + for icon lookup. */
  key: string;
  label: string;
  description: string;
  /** supervisord program name inside the engine (or the pg sidecar for postgresql). */
  unit: string;
  severity: MailComponentSeverity;
}

export const MAIL_COMPONENTS: MailComponentDef[] = [
  {
    key: "postfix",
    label: "Postfix",
    description: "SMTP server (receives + sends mail)",
    unit: "postfix",
    severity: "required",
  },
  {
    key: "dovecot",
    label: "Dovecot",
    description: "IMAP / POP3 / LMTP (inbox access + delivery)",
    unit: "dovecot",
    severity: "required",
  },
  {
    key: "amavis",
    label: "Amavis",
    description: "Filtering pipeline (spam + virus scan)",
    unit: "amavis",
    severity: "advisory",
  },
  {
    key: "clamav",
    label: "ClamAV",
    description: "Anti-virus engine",
    unit: "clamav-daemon",
    // Advisory to the INSTALL gate (a large signature load can still be warming
    // up), never "harmless": amavis has one scanner and no backup, so with clamd
    // gone mail is DELIVERED UNSCANNED — it does not defer (GH-565; failing closed
    // is an opt-in documented in the engine's amavisd.conf). The banner's copy
    // says exactly that, because "advisory" here means "delivery still works",
    // not "nothing is wrong".
    severity: "advisory",
  },
  {
    key: "freshclam",
    label: "ClamAV updates",
    description: "Auto-updates virus signatures",
    unit: "clamav-freshclam",
    severity: "advisory",
  },
  {
    key: "spamassassin",
    label: "SpamAssassin",
    description: "Spam scoring",
    // `spamd`, not `spamassassin`, on BOTH flavors: the Debian/Ubuntu package
    // (>=4.0) ships its systemd unit as `spamd.service`, so checking
    // `spamassassin` always read LoadState=not-found ("Missing") on a perfectly
    // healthy legacy host — and the engine image's supervisord program is named
    // to match.
    unit: "spamd",
    // INFORMATIONAL, not advisory (GH-240 FP1). Amavis scores spam through its own
    // in-process Mail::SpamAssassin integration, which is what actually tags mail on
    // this stack; `spamd` is the separate network-facing scorer that `spamc` and other
    // external tools talk to, and NOTHING here speaks to it. So its state carries no
    // information about whether spam filtering works, and reporting it as a degradation
    // was a false positive on every host that simply does not run it — the issue's
    // "SpamAssassin daemon reported not installed although SA scores in-process".
    // Still listed, because an operator who deliberately runs spamd wants to see it.
    severity: "informational",
  },
  {
    key: "iredapd",
    label: "iRedAPD",
    description: "Policy daemon (greylisting, throttling)",
    unit: "iredapd",
    severity: "advisory",
  },
  {
    key: "fail2ban",
    label: "fail2ban",
    description: "Brute-force protection",
    unit: "fail2ban",
    severity: "advisory",
  },
  {
    key: "postgresql",
    label: "PostgreSQL",
    description: "Mail account + alias store",
    unit: "postgresql",
    severity: "required",
  },
];

/** Normalized daemon state — defined with the probes that produce it. */
export type MailComponentStatus = MailUnitStatus;

export interface MailComponentHealth {
  key: string;
  label: string;
  description: string;
  unit: string;
  severity: MailComponentSeverity;
  status: MailComponentStatus;
  /**
   * The supervisor's state word (systemd's SubState, or supervisord's, lower-cased).
   * The only thing separating supervisord FATAL — given up — from BACKOFF, both of
   * which arrive as `status: "failed"`.
   */
  subState?: string;
  /** ISO timestamp the unit entered its current state, if known (systemd only). */
  activeSince?: string;
  /**
   * Why the status is `unknown` — the probe's own words. Absent for every state we
   * actually determined. Without it "unknown" is unactionable, and the operator's
   * only recourse is to SSH in and re-run the probe by hand.
   */
  detail?: string;
}

/** First meaningful line of probe output, capped for inline display. */
function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

/**
 * Probe every component: resolve the box's engine topology ONCE, then one exec per
 * daemon in parallel over the same channel. Roundtrips: O(components) + 1.
 *
 * A box with no mail engine at all reports every component `missing` rather than
 * `unknown` — "there is nothing here" is a conclusion, not a failed probe.
 */
export async function checkMailHealth(
  exec: CommandExecutor,
): Promise<MailComponentHealth[]> {
  const probe = await resolveMailEngine(exec).catch(() => null);
  if (probe?.flavor === "none") {
    return MAIL_COMPONENTS.map((comp) => ({ ...describe(comp), status: "missing" as const }));
  }
  const flavor = probe?.flavor ?? "container";
  return Promise.all(MAIL_COMPONENTS.map(async (comp) => probeUnit(exec, flavor, comp)));
}

/** The daemons that decide whether a box is delivering mail at all. */
const SERVING_COMPONENTS: readonly string[] = ["postfix", "dovecot"];

/**
 * Is this box serving mail right now?
 *
 * "An engine is here" and "mail is being delivered" are different questions: a
 * running container can hold a dead Postfix, and a legacy box can have its units
 * masked. This answers the second one — through the same catalog and the same
 * probe the health panel uses, so there is no second definition of "up" to drift
 * (the old copy hand-rolled `supervisorctl status` AND `systemctl is-active`,
 * which is how the container rewrite silently stopped recognising legacy boxes).
 *
 * Costs the topology probe + one exec per serving daemon (2), not the full
 * nine-component sweep: this runs on the scan / install pre-flight path.
 */
export async function mailIsServing(exec: CommandExecutor): Promise<boolean> {
  const probe = await resolveMailEngine(exec).catch(() => null);
  if (!probe || probe.flavor === "none" || !probe.running) return false;
  const comps = MAIL_COMPONENTS.filter((c) => SERVING_COMPONENTS.includes(c.key));
  if (comps.length !== SERVING_COMPONENTS.length) return false; // catalog drifted
  const states = await Promise.all(comps.map((c) => probeUnit(exec, probe.flavor, c)));
  return states.every((s) => s.status === "active");
}

function describe(comp: MailComponentDef) {
  return {
    key: comp.key,
    label: comp.label,
    description: comp.description,
    unit: comp.unit,
    severity: comp.severity,
  };
}

/**
 * Does this component gate "is this box a mail server?"
 *
 * THE definition — `stepDeployEngine`'s install gate and the Health banner both read
 * it, so a component can never be fatal to one and cosmetic to the other.
 * Deliberately NOT merged with `SERVING_COMPONENTS`: that answers a different
 * question ("is mail moving right now?", postfix + dovecot only) and PostgreSQL is
 * required-but-not-serving. Two questions, two lists.
 */
export function requiresMailComponent(key: string): boolean {
  return MAIL_COMPONENTS.some((c) => c.key === key && c.severity === "required");
}

async function probeUnit(
  exec: CommandExecutor,
  flavor: MailEngineFlavor,
  comp: MailComponentDef,
): Promise<MailComponentHealth> {
  const base = describe(comp);
  try {
    const raw = await exec.exec(mailUnitProbeCommand(flavor, comp.key, comp.unit));
    return { ...base, ...parseMailUnitProbe(flavor, comp.key, comp.unit, raw) };
  } catch (err) {
    return { ...base, status: "unknown", detail: firstLine(safeErrorMessage(err)) };
  }
}
