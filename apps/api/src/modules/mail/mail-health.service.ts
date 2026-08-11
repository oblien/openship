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

/** Components we check. `unit` is the supervisord program name in the engine image. */
export interface MailComponentDef {
  /** Stable id - used by the frontend as a React key + for icon lookup. */
  key: string;
  label: string;
  description: string;
  /** supervisord program name inside the engine (or the pg sidecar for postgresql). */
  unit: string;
}

export const MAIL_COMPONENTS: MailComponentDef[] = [
  {
    key: "postfix",
    label: "Postfix",
    description: "SMTP server (receives + sends mail)",
    unit: "postfix",
  },
  {
    key: "dovecot",
    label: "Dovecot",
    description: "IMAP / POP3 / LMTP (inbox access + delivery)",
    unit: "dovecot",
  },
  {
    key: "amavis",
    label: "Amavis",
    description: "Filtering pipeline (spam + virus scan)",
    unit: "amavis",
  },
  {
    key: "clamav",
    label: "ClamAV",
    description: "Anti-virus engine",
    unit: "clamav-daemon",
  },
  {
    key: "freshclam",
    label: "ClamAV updates",
    description: "Auto-updates virus signatures",
    unit: "clamav-freshclam",
  },
  {
    key: "spamassassin",
    label: "SpamAssassin",
    description: "Spam scoring",
    // `spamd`, not `spamassassin`, on BOTH flavors: the Debian/Ubuntu package
    // (>=4.0) ships its systemd unit as `spamd.service`, so checking
    // `spamassassin` always read LoadState=not-found ("Missing") on a perfectly
    // healthy legacy host — and the engine image's supervisord program is named
    // to match. Note Amavis scores spam via its own in-process
    // Mail::SpamAssassin integration regardless of this daemon's state; spamd is
    // the standalone network-facing scorer other tools (spamc) talk to, and this
    // check is about ITS state specifically.
    unit: "spamd",
  },
  {
    key: "iredapd",
    label: "iRedAPD",
    description: "Policy daemon (greylisting, throttling)",
    unit: "iredapd",
  },
  {
    key: "fail2ban",
    label: "fail2ban",
    description: "Brute-force protection",
    unit: "fail2ban",
  },
  {
    key: "postgresql",
    label: "PostgreSQL",
    description: "Mail account + alias store",
    unit: "postgresql",
  },
];

/** Normalized daemon state — defined with the probes that produce it. */
export type MailComponentStatus = MailUnitStatus;

export interface MailComponentHealth {
  key: string;
  label: string;
  description: string;
  unit: string;
  status: MailComponentStatus;
  /** Free-form sub-state when running — systemd's, or supervisord's state word. */
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
  };
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
