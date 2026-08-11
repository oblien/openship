/**
 * Mail-server health checks.
 *
 * For each daemon the slimmed iRedMail engine installs, run a cheap
 * `systemctl is-active <unit>` and a one-line uptime probe. Surface the
 * results to the dashboard so the Mail tab shows real running/stopped
 * state instead of a static "Bundled" badge.
 *
 * Service unit names target Debian/Ubuntu - that's what our slimmed
 * engine supports. If we add other distros later, the unit names map
 * will need DISTRO-aware branches.
 */

import type { CommandExecutor } from "@repo/adapters";

/** Components we check. `unit` is the systemd unit name on Debian/Ubuntu. */
export interface MailComponentDef {
  /** Stable id - used by the frontend as a React key + for icon lookup. */
  key: string;
  label: string;
  description: string;
  /** systemd unit. `null` for non-service components (none today). */
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
    // The Debian/Ubuntu spamassassin package (>=4.0) ships its systemd unit
    // as `spamd.service`, not `spamassassin.service` — checking the latter
    // always returned LoadState=not-found ("Missing") even on a fully
    // installed, correctly-configured host. Note Amavis scores spam via its
    // own in-process Mail::SpamAssassin integration regardless of this
    // daemon's state; spamd is the standalone network-facing scorer other
    // tools (spamc) can talk to — this check is about ITS state specifically.
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

export type MailComponentStatus =
  | "active"
  | "inactive"
  | "failed"
  | "activating"
  | "deactivating"
  | "missing"
  | "unknown";

export interface MailComponentHealth {
  key: string;
  label: string;
  description: string;
  unit: string;
  status: MailComponentStatus;
  /** systemd's free-form sub-state when running (e.g. "running"). */
  subState?: string;
  /** ISO timestamp the unit entered its current state, if known. */
  activeSince?: string;
}

/**
 * Probe every component in a single SSH session. Uses one `systemctl show`
 * batch per unit (cheap - Postfix/Dovecot/etc. are local services) and
 * parses key=value lines so we get state + sub-state + entry timestamp in
 * one round trip per unit.
 *
 * Total roundtrips: O(components). Could be batched into one shell pipe
 * with `systemctl show <unit1> <unit2> …` but the result parsing gets
 * fiddly - keep it simple and parallel-friendly via Promise.all.
 */
export async function checkMailHealth(
  exec: CommandExecutor,
): Promise<MailComponentHealth[]> {
  const results = await Promise.all(
    MAIL_COMPONENTS.map(async (comp) => probeUnit(exec, comp)),
  );
  return results;
}

async function probeUnit(
  exec: CommandExecutor,
  comp: MailComponentDef,
): Promise<MailComponentHealth> {
  try {
    // `systemctl show` prints requested properties as key=value lines.
    // LoadState=not-found means the unit doesn't exist on this host.
    const raw = await exec.exec(
      `systemctl show ${comp.unit} -p LoadState -p ActiveState -p SubState -p ActiveEnterTimestamp 2>/dev/null || true`,
    );
    const fields = parseKv(raw);

    if (!fields.LoadState || fields.LoadState === "not-found") {
      return {
        key: comp.key,
        label: comp.label,
        description: comp.description,
        unit: comp.unit,
        status: "missing",
      };
    }

    return {
      key: comp.key,
      label: comp.label,
      description: comp.description,
      unit: comp.unit,
      status: mapActiveState(fields.ActiveState),
      subState: fields.SubState || undefined,
      activeSince: parseTimestamp(fields.ActiveEnterTimestamp),
    };
  } catch {
    return {
      key: comp.key,
      label: comp.label,
      description: comp.description,
      unit: comp.unit,
      status: "unknown",
    };
  }
}

function parseKv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return out;
}

function mapActiveState(s: string | undefined): MailComponentStatus {
  switch (s) {
    case "active":
      return "active";
    case "inactive":
      return "inactive";
    case "failed":
      return "failed";
    case "activating":
      return "activating";
    case "deactivating":
      return "deactivating";
    default:
      return "unknown";
  }
}

/**
 * Parse `ActiveEnterTimestamp` → ISO 8601 string. systemd's format is
 * "Mon 2025-04-12 14:23:01 UTC" (or empty if never started). We normalise
 * to ISO so the frontend can do "<x> ago" with `Date()`.
 */
function parseTimestamp(s: string | undefined): string | undefined {
  if (!s || s.trim() === "" || s === "0") return undefined;
  // Strip the leading day-of-week ("Mon ") which Date() doesn't parse.
  const stripped = s.replace(/^[A-Z][a-z]{2}\s+/, "");
  const d = new Date(stripped);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}
