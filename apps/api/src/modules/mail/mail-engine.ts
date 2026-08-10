/**
 * The mail engine's topology matrix — and the ONLY place that knows it.
 *
 * A box runs mail in one of two shapes (see `detectMailEngine`): the supported
 * `container` engine + pg sidecar, or a LEGACY `host` install (systemd
 * Postfix/Dovecot, vmail in the host PostgreSQL). Same data, same daemons, same
 * DB name — different transport for every command that touches them:
 *
 * | concern      | container                                    | host                        |
 * |--------------|----------------------------------------------|-----------------------------|
 * | vmail SQL    | `docker exec openship-mail-db psql -U postgres` | `sudo -u postgres psql`  |
 * | daemon state | `supervisorctl status` in the engine          | `systemctl show`            |
 * | daemon action| `supervisorctl <action>` / `docker <action>`   | `systemctl --no-block`      |
 * | daemon logs  | supervisord's per-program log / `docker logs`  | `journalctl -u`             |
 * | postfix cmds | `docker exec openship-mail <cmd>`             | the command, on the host     |
 * | config files | host bind mount ↔ in-engine path              | one path, both sides         |
 *
 * Containerization replaced the host column wholesale instead of branching, which
 * is why a legacy box currently 500s in the admin panel ("No such container:
 * openship-mail-db") and shows up as a dead "Mail engine is down" in the fleet
 * view while it is quietly delivering mail. The image is not published yet, so
 * legacy is not a tail case — it is every mail box provisioned so far.
 *
 * The rule this file exists to enforce: **no other module branches on topology.**
 * Services ask for a command string and stay flavor-blind. When host-native
 * retires, `detectMailEngine` stops returning `"host"`, the `host` column here
 * becomes dead code in ONE file, and nothing else changes.
 *
 * Resolution is memoized per executor (WeakMap), so a request that runs 9 daemon
 * probes over one SSH connection probes the topology once, and the memo dies with
 * the connection (ssh-manager drops idle executors after 5 min) — there is no TTL
 * to tune and no cache to invalidate by hand. A command that fails with a
 * "wrong flavor" signature drops the memo and re-probes to report the accurate
 * reason, so a hand-migrated box self-corrects on its next call.
 */

import {
  detectMailEngine,
  MAIL_CONTAINER,
  MAIL_DB_CONTAINER,
  MAIL_DB_NAME,
  MAIL_HOST_PATHS,
  type CommandExecutor,
  type MailEngineFlavor,
  type MailEngineProbe,
} from "@repo/adapters";
import { AppError } from "@repo/core";

import { sshManager } from "../../lib/ssh-manager";

export type { MailEngineFlavor, MailEngineProbe };

/** Either a server id (we acquire the executor) or an executor already in hand. */
export type MailTarget = string | CommandExecutor;

/**
 * Why a mail operation can't run — with the remediation baked into the reason, so
 * every surface offers the same next step:
 *   - `not_installed` → there is no mail engine on this box (re-run mail setup),
 *   - `not_running`   → there is one, it just isn't up (the one-click repair).
 *
 * An `AppError` so the existing `handleApiError` / `errorJson` funnels turn it
 * into a 409 with a code the dashboard can branch on, instead of the bare 500 a
 * raw "No such container" produced.
 */
export type MailEngineUnavailableReason = "not_installed" | "not_running";

export class MailEngineUnavailableError extends AppError {
  constructor(
    readonly reason: MailEngineUnavailableReason,
    readonly flavor: MailEngineFlavor,
    message?: string,
  ) {
    super(
      message ??
        (reason === "not_installed"
          ? "This server has no mail engine. Run mail setup on it first."
          : "The mail engine on this server isn't running."),
      409,
      reason === "not_installed" ? "MAIL_ENGINE_NOT_INSTALLED" : "MAIL_ENGINE_NOT_RUNNING",
    );
    this.name = "MailEngineUnavailableError";
  }
}

// ─── Resolution ──────────────────────────────────────────────────────────────

const probes = new WeakMap<CommandExecutor, Promise<MailEngineProbe>>();

/**
 * The box's mail topology, memoized per executor. The in-flight promise is what's
 * cached, so concurrent callers on one connection share a single probe.
 */
export async function resolveMailEngine(executor: CommandExecutor): Promise<MailEngineProbe> {
  const cached = probes.get(executor);
  if (cached) return cached;
  // Cache the promise, not the result — and drop it if the probe itself throws,
  // so a transient SSH failure isn't remembered as "no mail engine".
  const pending = detectMailEngine(executor).catch((err: unknown) => {
    probes.delete(executor);
    throw err;
  });
  probes.set(executor, pending);
  return pending;
}

/** Drop the memoized topology for this executor (a command said it was wrong). */
export function forgetMailEngine(executor: CommandExecutor): void {
  probes.delete(executor);
}

/** Run `fn` with a resolved topology, acquiring the executor when given a serverId. */
export async function withMailEngine<T>(
  target: MailTarget,
  fn: (probe: MailEngineProbe, executor: CommandExecutor) => Promise<T>,
): Promise<T> {
  if (typeof target === "string") {
    return sshManager.withExecutor(target, async (executor) =>
      fn(await resolveMailEngine(executor), executor),
    );
  }
  return fn(await resolveMailEngine(target), target);
}

/**
 * Resolve the topology and refuse when the engine can't serve — the gate every
 * write path should sit behind so an operator gets "the engine is stopped, here's
 * the fix" instead of a shell error from three layers down.
 */
export async function requireMailEngine(target: MailTarget): Promise<MailEngineProbe> {
  return withMailEngine(target, async (probe) => {
    assertUsable(probe);
    return probe;
  });
}

function assertUsable(probe: MailEngineProbe): void {
  if (probe.flavor === "none") throw new MailEngineUnavailableError("not_installed", probe.flavor);
  if (!probe.running) throw new MailEngineUnavailableError("not_running", probe.flavor);
}

/**
 * Build a flavor-correct command, run it, and translate a topology failure into
 * the typed error. THE exec chokepoint for mail: every service goes through it,
 * which is what keeps the docker/systemd strings inside this file.
 *
 * `build` receives the resolved flavor and returns the command to run — so a
 * caller that needs its own wrapping (exit-code sentinels, `|| true`, `timeout`)
 * still gets the flavor-correct inner command without knowing the topology.
 */
export async function runMailCommand(
  target: MailTarget,
  build: (flavor: MailEngineFlavor) => string,
  opts: { timeout?: number; requireRunning?: boolean } = {},
): Promise<{ flavor: MailEngineFlavor; output: string }> {
  return withMailEngine(target, async (probe, executor) => {
    if (probe.flavor === "none") {
      throw new MailEngineUnavailableError("not_installed", probe.flavor);
    }
    if (opts.requireRunning !== false && !probe.running) {
      throw new MailEngineUnavailableError("not_running", probe.flavor);
    }

    const command = build(probe.flavor);
    try {
      const output = await executor.exec(
        command,
        opts.timeout ? { timeout: opts.timeout } : undefined,
      );
      // A command can fail without throwing (`|| true`, sentinel wrappers). Check
      // the OUTPUT too, or a stale topology survives every non-throwing caller.
      if (looksLikeWrongFlavor(output, probe.flavor)) {
        throw await reclassify(executor, probe, output);
      }
      return { flavor: probe.flavor, output };
    } catch (err) {
      if (err instanceof MailEngineUnavailableError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (looksLikeWrongFlavor(message, probe.flavor)) {
        throw await reclassify(executor, probe, message);
      }
      throw err;
    }
  });
}

/**
 * Does this output mean "you talked to the wrong topology / the engine is gone"?
 *
 * Per-flavor on purpose: docker's "No such container" is conclusive for the
 * container flavor, and on a legacy box the equivalent is `psql`/`sudo` not being
 * there at all. Anything else (a SQL error, a permission problem) is a real
 * failure the caller must keep seeing verbatim.
 */
function looksLikeWrongFlavor(text: string, flavor: MailEngineFlavor): boolean {
  if (!text) return false;
  if (flavor === "container") {
    return /no such container|no such object|is not running|cannot exec in a stopped container|cannot connect to the docker daemon/i.test(
      text,
    );
  }
  if (flavor === "host") {
    return /psql: (command )?not found|command not found: psql|unknown user:? postgres|no such file or directory: sudo/i.test(
      text,
    );
  }
  return false;
}

/**
 * The topology changed under us (a hand-run migration, a removed container).
 * Re-probe once — for the DIAGNOSIS only, never to re-run the command — and
 * report what's actually there now. Re-running is deliberately not done here: a
 * mutation that half-applied must not be replayed against a different engine.
 */
async function reclassify(
  executor: CommandExecutor,
  previous: MailEngineProbe,
  detail: string,
): Promise<MailEngineUnavailableError> {
  forgetMailEngine(executor);
  const fresh = await resolveMailEngine(executor).catch(() => previous);
  if (fresh.flavor === "none") {
    return new MailEngineUnavailableError(
      "not_installed",
      fresh.flavor,
      "The mail engine is no longer on this server — its container is gone. Re-run mail setup to recreate it.",
    );
  }
  return new MailEngineUnavailableError(
    "not_running",
    fresh.flavor,
    `The mail engine on this server isn't serving right now (${firstLine(detail)}).`,
  );
}

function firstLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "no output";
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

// ─── The matrix (pure builders — no I/O, so they're unit-testable) ────────────

/** Single-quote a value for safe shell interpolation. */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * psql against the `vmail` database.
 *
 * Same database name, same flags, same single shell-quoted `-c` argv on both
 * flavors — only the transport differs. `-A -t` strips headers/alignment;
 * `ON_ERROR_STOP=1` fails loud so `execute()` throws instead of silently
 * half-applying. NEVER a heredoc: a fixed delimiter lets a value containing that
 * delimiter close it early and turn the rest into shell commands.
 */
export function mailPsqlCommand(flavor: MailEngineFlavor, sql: string): string {
  const flags = `-d ${MAIL_DB_NAME} -A -t -v ON_ERROR_STOP=1 -c ${sq(sql)}`;
  // Container: connect as the sidecar's `postgres` superuser (the container-model
  // equivalent of `sudo -u postgres`, which is exactly what legacy boxes use).
  return flavor === "container"
    ? `docker exec ${MAIL_DB_CONTAINER} psql -U postgres ${flags}`
    : `sudo -u postgres psql ${flags}`;
}

/**
 * Run a command where Postfix/Dovecot and their config live — `postmap`,
 * `postconf`, `postfix reload`. On a legacy box that's the host itself.
 */
export function mailEngineCommand(flavor: MailEngineFlavor, cmd: string): string {
  return flavor === "container" ? `docker exec ${MAIL_CONTAINER} ${cmd}` : cmd;
}

/** The path each editable config file has INSIDE the engine (= on a legacy host). */
const MAIL_ENGINE_PATHS = {
  saslPasswd: "/etc/postfix/sasl_passwd",
  senderRelayhost: "/etc/postfix/sender_relayhost",
  amavisUserConf: "/etc/amavis/conf.d/50-user",
} as const satisfies Record<keyof typeof MAIL_HOST_PATHS, string>;

/**
 * Where an editable daemon config file lives on each side.
 *
 * `write` is the path to WRITE (always a real host path — `exec.writeFile` uses
 * SFTP with no shell, the SASL-password security invariant); `engine` is the path
 * the daemon itself sees, which is what `postmap` / `postconf` / a `dkim_key(...)`
 * directive must reference. On the container flavor those are the two ends of a
 * bind mount (`MAIL_CONTAINER_MOUNTS`); on a legacy box they're the same file.
 */
export function mailConfigFile(
  flavor: MailEngineFlavor,
  file: keyof typeof MAIL_ENGINE_PATHS,
): { write: string; engine: string } {
  const engine = MAIL_ENGINE_PATHS[file];
  return flavor === "container" ? { write: MAIL_HOST_PATHS[file], engine } : { write: engine, engine };
}

// ─── Daemon state ────────────────────────────────────────────────────────────

/** Normalized daemon state, shared by both flavors' probes. */
export type MailUnitStatus =
  | "active"
  | "inactive"
  | "failed"
  | "activating"
  | "deactivating"
  | "missing"
  | "unknown";

export interface MailUnitState {
  status: MailUnitStatus;
  /** Free-form sub-state when running (systemd's, or supervisord's state word). */
  subState?: string;
  /** ISO timestamp the unit entered its current state — systemd only. */
  activeSince?: string;
  /** Why the status is `unknown` — the probe's own words. */
  detail?: string;
}

/**
 * Probe one daemon. `key` selects the DB special case (a sidecar container vs a
 * plain systemd unit); `unit` is the supervisord program name, which the engine
 * image deliberately keeps identical to the legacy systemd unit name so one
 * catalog (`MAIL_COMPONENTS`) serves both flavors.
 *
 * `2>&1 || true` on purpose: the probe's own failure has to stay readable, or an
 * unreachable daemon is indistinguishable from an uninstalled one.
 */
export function mailUnitProbeCommand(
  flavor: MailEngineFlavor,
  key: string,
  unit: string,
): string {
  if (flavor === "container") {
    return key === "postgresql"
      ? `docker inspect -f '{{.State.Running}}' ${sq(MAIL_DB_CONTAINER)} 2>&1 || true`
      : `docker exec ${sq(MAIL_CONTAINER)} supervisorctl status ${sq(unit)} 2>&1 || true`;
  }
  return `systemctl show ${sq(unit)} -p LoadState -p ActiveState -p SubState -p ActiveEnterTimestamp 2>&1 || true`;
}

/** Parse whatever {@link mailUnitProbeCommand} produced into a normalized state. */
export function parseMailUnitProbe(
  flavor: MailEngineFlavor,
  key: string,
  unit: string,
  raw: string,
): MailUnitState {
  if (flavor === "container") {
    if (key === "postgresql") {
      const value = firstOutputLine(raw);
      if (value === "true") return { status: "active" };
      if (value === "false") return { status: "inactive" };
      // Only docker saying the container isn't there means missing. A refused
      // daemon or a permission error is a probe we can't conclude from.
      if (/no such object|no such container/i.test(value)) return { status: "missing" };
      return { status: "unknown", detail: value || "probe returned no output" };
    }
    // supervisord always names the program it reports on — "postfix RUNNING pid 12,
    // uptime 0:03:11", or "postfix: ERROR (no such process)". No such line means
    // supervisord never answered (engine down, docker unreachable, exec refused),
    // which is UNKNOWN: calling it "missing" blames the daemon for a docker problem.
    const stateLine = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l === unit || l.startsWith(`${unit} `) || l.startsWith(`${unit}:`));
    if (!stateLine) {
      return { status: "unknown", detail: firstOutputLine(raw) || "probe returned no output" };
    }
    if (/no such process/i.test(stateLine)) return { status: "missing" };
    const word = stateLine.split(/\s+/)[1] ?? "";
    return { status: mapSupervisorState(word), subState: word.toLowerCase() || undefined };
  }

  const props = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) props.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  const load = props.get("LoadState");
  if (!load) {
    return { status: "unknown", detail: firstOutputLine(raw) || "probe returned no output" };
  }
  if (load === "not-found") return { status: "missing" };
  const activeState = props.get("ActiveState") ?? "";
  const since = props.get("ActiveEnterTimestamp");
  return {
    status: mapActiveState(activeState),
    subState: props.get("SubState") || undefined,
    activeSince: parseSystemdTimestamp(since),
  };
}

/**
 * Act on one daemon. Both flavors return the instant the supervisor accepts the
 * job (`--no-block` / supervisorctl's own behaviour) — a `systemctl restart
 * dovecot` that waits for stuck IMAP workers outlives the SSH command timeout.
 */
export function mailUnitActionCommand(
  flavor: MailEngineFlavor,
  key: string,
  unit: string,
  action: "start" | "stop" | "restart",
): string {
  if (flavor === "container") {
    return key === "postgresql"
      ? `docker ${action} ${MAIL_DB_CONTAINER}`
      : `docker exec ${MAIL_CONTAINER} supervisorctl ${action} ${unit}`;
  }
  return `systemctl --no-block ${action} ${unit}`;
}

/**
 * Tail one daemon's logs. supervisord writes each program to
 * `/var/log/supervisor/<program>.log` (see apps/email's supervisord.conf); the
 * sidecar logs to its container; a legacy box has journald. `timeout 10` caps the
 * exec so a hung log can't sit on the SSH channel.
 */
export function mailUnitLogsCommand(
  flavor: MailEngineFlavor,
  key: string,
  unit: string,
  lines: number,
): string {
  if (flavor === "container") {
    return key === "postgresql"
      ? `timeout 10 docker logs --tail ${lines} ${MAIL_DB_CONTAINER} 2>&1 || true`
      : `timeout 10 docker exec ${MAIL_CONTAINER} tail -n ${lines} /var/log/supervisor/${unit}.log 2>/dev/null || true`;
  }
  return `timeout 10 journalctl -u ${sq(unit)} -n ${lines} --no-pager 2>&1 || true`;
}

function firstOutputLine(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return "";
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function mapSupervisorState(s: string): MailUnitStatus {
  switch (s.toUpperCase()) {
    case "RUNNING":
      return "active";
    case "STOPPED":
    case "EXITED":
      return "inactive";
    case "FATAL":
    case "BACKOFF":
      return "failed";
    case "STARTING":
      return "activating";
    case "STOPPING":
      return "deactivating";
    default:
      return "unknown";
  }
}

function mapActiveState(s: string): MailUnitStatus {
  switch (s) {
    case "active":
      return "active";
    case "inactive":
      return "inactive";
    case "failed":
      return "failed";
    case "activating":
    case "reloading":
      return "activating";
    case "deactivating":
      return "deactivating";
    default:
      return "unknown";
  }
}

/**
 * systemd prints `ActiveEnterTimestamp=Tue 2026-08-04 14:22:05 UTC` (and an empty
 * value for a unit that never started). Return an ISO string when it parses, and
 * nothing when it doesn't — a malformed timestamp must not become an invalid Date
 * in the API response.
 */
function parseSystemdTimestamp(value: string | undefined): string | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const parsed = new Date(raw.replace(/^[A-Za-z]{3}\s+/, ""));
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}
