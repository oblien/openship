/**
 * Mail server setup service - orchestrates iRedMail installation against a
 * `CommandExecutor`, broken into discrete resumable steps.
 *
 * Locality-agnostic: every step receives a `CommandExecutor`, which can be
 * a `LocalExecutor` (same machine, child_process + fs) or an `SshExecutor`
 * (remote VPS, ssh2). This file does not know - or care - which.
 *
 * The engine tree (`apps/email/engine/`) is the source of truth: step 6
 * transfers it onto the target box via `executor.transferIn`, and step 8
 * runs `iRedMail.sh` from that copy. We don't `wget` upstream tarballs;
 * the in-repo engine is what gets installed.
 */

import { resolve } from "node:path";
import { randomBytes } from "node:crypto";
import type { CommandExecutor, LogEntry, SystemLogCallback, SystemLog } from "@repo/adapters";
import { updatePostmasterPassword } from "./mail-credentials.service";
import { safeErrorMessage } from "@repo/core";
import {
  installRsync,
  installOpenResty,
  installCertbot,
  foreignProxyOnEdge,
} from "@repo/adapters";

// ─── Shell quoting helper ─────────────────────────────────────────────────────

/** Single-quote a value for safe shell interpolation. */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ─── Engine source-of-truth ──────────────────────────────────────────────────

/**
 * Where the iRedMail engine tree is staged on the target machine before the
 * installer runs. Same path for local and remote executors - the executor
 * abstracts how bytes get there.
 */
const REMOTE_ENGINE_DIR = "/root/iRedMail-engine";

/**
 * Absolute path to `apps/email/engine/` on the openship API host.
 *
 * `MAIL_SERVER_ENGINE_DIR` overrides for ops who pin a packaged build to a
 * fixed location; otherwise resolved relative to apps/api's cwd so the
 * monorepo dev layout works without configuration.
 */
function resolveLocalEngineDir(): string {
  if (process.env.MAIL_SERVER_ENGINE_DIR) {
    return process.env.MAIL_SERVER_ENGINE_DIR;
  }
  return resolve(process.cwd(), "../../apps/email/engine");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(err: unknown): string {
  return safeErrorMessage(err);
}

/**
 * Probe whether a working iRedMail stack is already installed on the server.
 * iRedMail is "present" when both postfix and dovecot are active systemd
 * services. Used by the install pre-flight (to skip the engine + rotate the
 * postmaster password) AND by the "scan & adopt" flow (to re-adopt a server
 * whose orchestrator state was lost). Pure read — no mutation.
 */
export async function detectMailInstall(exec: CommandExecutor): Promise<boolean> {
  const postfixState = (
    await exec.exec("systemctl is-active postfix 2>/dev/null || echo missing")
  ).trim();
  const dovecotState = (
    await exec.exec("systemctl is-active dovecot 2>/dev/null || echo missing")
  ).trim();
  return postfixState === "active" && dovecotState === "active";
}

/**
 * Run a command with real-time log streaming.
 * Every stdout/stderr line is forwarded to the StepLogger so the frontend
 * sees actual SSH output as it happens.
 */
async function streamCmd(
  exec: CommandExecutor,
  command: string,
  stepId: number,
  log: StepLogger,
): Promise<{ code: number; output: string }> {
  return exec.streamExec(command, (entry: LogEntry) => {
    log(stepId, entry.level, entry.message);
  });
}

/**
 * Adapt our step-aware `StepLogger` to the `SystemLogCallback` shape used
 * by the component installers in `@repo/adapters`.
 */
function bridgeToSystemLog(stepId: number, log: StepLogger): SystemLogCallback {
  return (sl: SystemLog) => log(stepId, sl.level, sl.message);
}

// ─── Step definitions ────────────────────────────────────────────────────────

export interface MailSetupStep {
  id: number;
  key: string;
  label: string;
  description: string;
}

/**
 * Per-step max duration. A step that exceeds this fails with "step timed out"
 * - the SSH command keeps running on the server, but the wizard surfaces a
 * Retry so the user isn't stuck staring at silent UI.
 *
 * Defaults err on the generous side. `run_installer` is the only really long
 * one (apt fetches ~250 packages, plus iRedMail config + DB init). Reboot
 * step already has its own internal reconnect loop.
 */
export const STEP_TIMEOUT_MS: Record<string, number> = {
  system_update:        5 * 60_000,   // apt update + upgrade
  ensure_components:    8 * 60_000,   // rsync + openresty + certbot install
  check_port_25:        30_000,
  ensure_reverse_proxy: 30_000,
  set_hostname:         30_000,
  update_hosts:         30_000,
  transfer_engine:     10 * 60_000,   // rsync the engine - depends on link speed
  prepare_engine:       30_000,
  run_installer:       30 * 60_000,   // the big one: package install + setup
  first_reboot:        10 * 60_000,   // includes 30s sleep + 12×10s reconnect attempts
  dkim_keys:            60_000,
  request_ssl:          5 * 60_000,
  configure_ssl:        2 * 60_000,
};

/** Fallback when a step key isn't in the map. Never used as long as the map stays in sync. */
export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;

export const MAIL_SETUP_STEPS: MailSetupStep[] = [
  { id: 1,  key: "system_update",        label: "System Update",             description: "Update and upgrade system packages" },
  { id: 2,  key: "ensure_components",    label: "Ensure System Components",  description: "Install rsync, OpenResty, and certbot if missing" },
  { id: 3,  key: "check_port_25",        label: "Check Port 25",             description: "Verify outbound SMTP port is open" },
  { id: 4,  key: "ensure_reverse_proxy", label: "Ensure Reverse Proxy",      description: "Confirm OpenResty owns ports 80/443" },
  { id: 5,  key: "set_hostname",         label: "Set Hostname",              description: "Configure server hostname to mail subdomain" },
  { id: 6,  key: "update_hosts",         label: "Update /etc/hosts",         description: "Add mail domain to hosts file" },
  { id: 7,  key: "transfer_engine",      label: "Transfer iRedMail Engine",  description: `Stage apps/email/engine to ${REMOTE_ENGINE_DIR}` },
  { id: 8,  key: "prepare_engine",       label: "Prepare iRedMail Engine",   description: "Verify engine layout and make iRedMail.sh executable" },
  { id: 9,  key: "run_installer",        label: "Run iRedMail Installer",    description: "Execute the iRedMail setup wizard (mail daemons only)" },
  { id: 10, key: "first_reboot",         label: "Reboot Server",             description: "Reboot to activate mail services" },
  { id: 11, key: "dkim_keys",            label: "Retrieve DKIM Keys",        description: "Get DKIM keys and DNS records" },
  { id: 12, key: "request_ssl",          label: "Request SSL Certificate",   description: "Obtain Let's Encrypt SSL for mail domain" },
  { id: 13, key: "configure_ssl",        label: "Configure SSL",             description: "Link certificates and reload mail daemons" },
];

export const TOTAL_STEPS = MAIL_SETUP_STEPS.length;

// ─── Step result ─────────────────────────────────────────────────────────────

export interface StepResult {
  stepId: number;
  success: boolean;
  message: string;
  /** Extra data the step may return (e.g. DKIM keys, DNS records) */
  data?: Record<string, unknown>;
  /** Warning that doesn't block progress */
  warning?: string;
}

// ─── Logger callback type ────────────────────────────────────────────────────

export type StepLogger = (
  stepId: number,
  level: "info" | "warn" | "error",
  message: string,
) => void;

// ─── iRedMail config ─────────────────────────────────────────────────────────

export interface IRedMailConfig {
  /** Admin password for the postmaster account. Generated if absent. */
  adminPassword?: string;
  /** Storage backend: mariadb | postgresql (default: postgresql) */
  storageBackend?: "mariadb" | "postgresql";
  /**
   * Previously-generated secrets to reuse on a retry, keyed exactly as the
   * iRedMail config expects (`VMAIL_DB_BIND_PASSWD`, `MYSQL_ROOT_PASSWD`,
   * etc.). Any key present here overrides a freshly-generated value.
   *
   * Why this matters: iRedMail writes the generated passwords into its
   * postfix/dovecot/amavisd configs the first time it runs. A retry with
   * fresh passwords would write *different* configs while Postgres still
   * holds the original credentials → broken install. Persisting + reusing
   * the original set is the fix.
   */
  prefillSecrets?: Record<string, string>;
}

// ─── Step runners ────────────────────────────────────────────────────────────

/** Step 1: apt-get update && apt-get upgrade (streamed) */
export async function stepSystemUpdate(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  log(1, "info", "Updating package lists...");
  const update = await streamCmd(exec, "DEBIAN_FRONTEND=noninteractive apt-get update -y", 1, log);
  if (update.code !== 0) {
    return { stepId: 1, success: false, message: "apt-get update failed" };
  }

  log(1, "info", "Upgrading packages...");
  const upgrade = await streamCmd(exec, "DEBIAN_FRONTEND=noninteractive apt-get -y upgrade", 1, log);
  if (upgrade.code !== 0) {
    return { stepId: 1, success: false, message: "apt-get upgrade failed" };
  }

  log(1, "info", "System updated successfully");
  return { stepId: 1, success: true, message: "System updated successfully" };
}

/** Step 3: Check outbound port 25 */
export async function stepCheckPort25(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 3;
  log(stepId, "info", "Testing outbound SMTP port 25...");
  const output = await exec.exec(
    "timeout 5 bash -c '</dev/tcp/portquiz.net/25' 2>&1 && echo PORT_OPEN || echo PORT_BLOCKED",
  );

  if (output.includes("PORT_OPEN")) {
    log(stepId, "info", "Port 25 is accessible");
    return { stepId, success: true, message: "Port 25 is accessible" };
  }

  log(stepId, "warn", "Port 25 may be blocked - mail delivery could be affected");
  return {
    stepId,
    success: true,
    message: "Port 25 may be blocked by ISP",
    warning: "Port 25 appears blocked. Mail delivery may be affected. You can continue, but some providers block outbound SMTP.",
  };
}

/**
 * Step 2: Ensure rsync + OpenResty + certbot are installed on the target.
 *
 * Reuses the existing component installers from `@repo/adapters` - same
 * code path the regular server-setup wizard uses, so we don't fork a
 * second install story for mail boxes.
 *
 *   - rsync     → required by `transferIn` (engine staging in step 7)
 *   - OpenResty → openship's routing layer; owns :80 / :443 from now on
 *   - certbot   → used by step 12 (request_ssl) for mail.<domain>
 */
export async function stepEnsureComponents(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 2;
  const sysLog = bridgeToSystemLog(stepId, log);

  for (const [name, install] of [
    ["rsync", installRsync],
    ["OpenResty", installOpenResty],
    ["certbot", installCertbot],
  ] as const) {
    log(stepId, "info", `Ensuring ${name}...`);
    const r = await install(exec, sysLog);
    if (!r.success) {
      return {
        stepId,
        success: false,
        message: `${name} install failed: ${r.error ?? "unknown error"}`,
      };
    }
    log(stepId, "info", `${name} ready${r.version ? ` (${r.version})` : ""}`);
  }

  return { stepId, success: true, message: "rsync, OpenResty, and certbot are installed" };
}

/**
 * Step 4: Ensure OpenResty is running and owns :80 / :443.
 *
 * After step 2 it's installed; this step confirms the daemon is up + ports
 * are bound by it (rather than by some unexpected process). If openresty
 * is down, start it. We DON'T scan for "conflicts" anymore - we expect
 * OpenResty to be the owner and treat anything else as an error.
 */
export async function stepEnsureReverseProxy(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 4;
  log(stepId, "info", "Checking OpenResty service status...");

  const active = (
    await exec.exec("systemctl is-active openresty 2>/dev/null || echo inactive")
  ).trim();

  if (active !== "active") {
    log(stepId, "info", "OpenResty is not running - starting it...");
    try {
      await exec.exec("systemctl start openresty");
    } catch (err) {
      return {
        stepId,
        success: false,
        message: `Failed to start OpenResty: ${errMsg(err)}`,
      };
    }
  }

  // Confirm OUR OpenResty owns 80/443 — via the SHARED edge detector (same one
  // the deploy pipeline / self-app use), not an ad-hoc ss/regex. A foreign proxy
  // holding the ports is surfaced as an error; mail never blind-takes-over
  // someone's proxy (the operator stops/migrates it via the dashboard and reruns).
  const { blocked, owner } = await foreignProxyOnEdge(exec);
  if (blocked) {
    return {
      stepId,
      success: false,
      message: `Ports 80/443 are held by another proxy (${owner}). Stop it, or migrate it from the dashboard, then rerun.`,
    };
  }

  log(stepId, "info", "OpenResty is running and holds :80 / :443");
  return { stepId, success: true, message: "OpenResty is the active reverse proxy" };
}

/** Step 5: Set hostname to mail.<domain> */
export async function stepSetHostname(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 5;
  const mailDomain = `mail.${domain}`;
  log(stepId, "info", `Checking current hostname...`);

  const currentHostname = (await exec.exec("hostname -f")).trim();
  log(stepId, "info", `Current hostname: ${currentHostname}`);

  if (currentHostname === mailDomain) {
    log(stepId, "info", "Hostname already correct");
    return { stepId, success: true, message: "Hostname already correct" };
  }

  log(stepId, "info", `Setting hostname to ${mailDomain}...`);
  try {
    await exec.exec(`hostnamectl set-hostname ${sq(mailDomain)}`);
  } catch (err) {
    return { stepId, success: false, message: `Failed to set hostname: ${errMsg(err)}` };
  }

  log(stepId, "info", `Hostname set to ${mailDomain}`);
  return { stepId, success: true, message: `Hostname set to ${mailDomain}` };
}

/** Step 6: Update /etc/hosts with 127.0.1.1 mail.<domain> */
export async function stepUpdateHosts(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 6;
  const mailDomain = `mail.${domain}`;
  log(stepId, "info", "Checking /etc/hosts...");

  const countStr = await exec.exec(`grep -c '^127.0.1.1' /etc/hosts || echo 0`);
  const hasEntry = parseInt(countStr.trim(), 10) > 0;

  if (hasEntry) {
    const pattern = `^127\\.0\\.1\\.1.*${mailDomain}`;
    const correctStr = await exec.exec(
      `grep -c ${sq(pattern)} /etc/hosts || echo 0`,
    );
    if (parseInt(correctStr.trim(), 10) > 0) {
      log(stepId, "info", "/etc/hosts already configured correctly");
      return { stepId, success: true, message: "/etc/hosts already configured" };
    }

    log(stepId, "info", "Updating existing 127.0.1.1 entry...");
    const sedReplace = `s/^127\\.0\\.1\\.1.*/127.0.1.1 ${mailDomain} ${domain}/`;
    await exec.exec(
      `sed -i ${sq(sedReplace)} /etc/hosts`,
    );
  } else {
    log(stepId, "info", "Adding 127.0.1.1 entry...");
    const sedAppend = `/127.0.0.1/a 127.0.1.1 ${mailDomain} ${domain}`;
    await exec.exec(
      `sed -i ${sq(sedAppend)} /etc/hosts`,
    );
  }

  const hosts = await exec.exec("cat /etc/hosts");
  log(stepId, "info", `Updated /etc/hosts:\n${hosts}`);
  return { stepId, success: true, message: "/etc/hosts updated" };
}

/**
 * Step 6: Stage the in-repo iRedMail engine onto the target machine.
 *
 * `executor.transferIn` decides locality: `LocalExecutor` does `cp -a`,
 * `SshExecutor` tars locally + untars remotely. Same destination path
 * either way, same code path in this service.
 */
export async function stepTransferEngine(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 7;
  const localEngine = resolveLocalEngineDir();
  log(stepId, "info", `Transferring engine ${localEngine} → ${REMOTE_ENGINE_DIR}...`);

  try {
    await exec.transferIn(localEngine, REMOTE_ENGINE_DIR, (entry) => {
      log(stepId, entry.level, entry.message);
    });
  } catch (err) {
    return { stepId, success: false, message: `Engine transfer failed: ${errMsg(err)}` };
  }

  log(stepId, "info", "Engine staged");
  return { stepId, success: true, message: `Engine staged at ${REMOTE_ENGINE_DIR}` };
}

/**
 * Step 7: Sanity-check the staged engine and ensure iRedMail.sh is executable.
 *
 * The transferIn in step 6 preserves permissions when possible, but a chmod
 * here makes the step idempotent across executor implementations.
 */
export async function stepPrepareEngine(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 8;
  log(stepId, "info", "Verifying iRedMail.sh is present...");
  const exists = await exec.exec(
    `[ -f ${REMOTE_ENGINE_DIR}/iRedMail.sh ] && echo OK || echo MISSING`,
  );
  if (!exists.includes("OK")) {
    return {
      stepId,
      success: false,
      message: `iRedMail.sh not found at ${REMOTE_ENGINE_DIR} - engine transfer incomplete`,
    };
  }

  log(stepId, "info", "Making iRedMail.sh executable...");
  try {
    await exec.exec(`chmod +x ${REMOTE_ENGINE_DIR}/iRedMail.sh`);
  } catch (err) {
    return { stepId, success: false, message: `chmod failed: ${errMsg(err)}` };
  }

  return { stepId, success: true, message: "Engine ready to install" };
}

/** Random URL-safe secret. iRedMail's installer treats these as opaque strings. */
export function genSecret(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Verify-or-repair fail2ban's PostgreSQL auth.
 *
 * The cron job at /etc/cron.d/iredmail runs `fail2ban_banned_db unban_db` as
 * root every minute. The script discovers `/var/lib/postgresql/.pgpass`,
 * exports it as PGPASSFILE, and runs `psql -U fail2ban -d fail2ban`. If the
 * password in `.pgpass` and the PG role's password don't match, psql falls
 * through to a prompt - which fails non-interactively and cron mails root.
 *
 * This is the install-pipeline self-heal: idempotently re-align the role's
 * password with `.pgpass`. On older boxes provisioned before the
 * FAIL2BAN_DB_PASSWD-was-missing bug was fixed, `.pgpass` still has an empty
 * password field and the role has whatever Postgres rejected as empty. Use
 * the new `desiredPassword` to rewrite both in lockstep.
 *
 * No-ops gracefully if fail2ban isn't installed on the box.
 */
async function repairFail2banAuth(
  exec: CommandExecutor,
  desiredPassword: string,
  stepId: number,
  log: StepLogger,
): Promise<void> {
  // Bail out if fail2ban isn't on the box - slimmed-down installs without
  // USE_FAIL2BAN=YES shouldn't error here.
  const present = (
    await exec.exec(
      "[ -f /var/lib/postgresql/.pgpass ] && command -v fail2ban-client >/dev/null 2>&1 && echo YES || echo NO",
    )
  ).trim();
  if (!present.includes("YES")) {
    log(stepId, "info", "fail2ban not installed - skipping auth repair.");
    return;
  }

  // Probe: does the existing .pgpass line let us auth right now? If yes,
  // nothing to do. We try psql under PGPASSFILE - same path the cron uses.
  const probe = (
    await exec.exec(
      "sudo -u postgres bash -c 'PGPASSFILE=/var/lib/postgresql/.pgpass psql -U fail2ban -d fail2ban -tAc \"SELECT 1\" 2>&1' || true",
    )
  ).trim();
  if (probe === "1") {
    log(stepId, "info", "fail2ban PostgreSQL auth is healthy - no repair needed.");
    return;
  }

  log(
    stepId,
    "warn",
    `fail2ban PostgreSQL auth is broken (probe: ${probe.slice(0, 120)}). Repairing…`,
  );

  // Rotate the PG role password to `desiredPassword`. Single-quote-wrap the
  // password and escape inner quotes the PostgreSQL way (double the quote).
  const pgQuoted = desiredPassword.replace(/'/g, "''");
  await exec.exec(
    `sudo -u postgres psql -d template1 -v ON_ERROR_STOP=1 -c "ALTER ROLE fail2ban WITH ENCRYPTED PASSWORD '${pgQuoted}';"`,
  );

  // Rewrite the fail2ban line in .pgpass to match. The .pgpass format is
  // `host:port:db:user:password` - every field is `*` here, no quoting.
  // sed-delete any existing fail2ban line, then append the fresh one. Doing
  // both as `postgres` keeps the file ownership/mode (0600) intact.
  const newLine = `*:*:*:fail2ban:${desiredPassword}`;
  // Escape sed special chars in the replacement just in case (`/` and `&`).
  const sedSafe = newLine.replace(/[\\/&]/g, "\\$&");
  await exec.exec(
    `sudo -u postgres bash -c "sed -i '/^[^:]*:[^:]*:[^:]*:fail2ban:/d' /var/lib/postgresql/.pgpass && printf '%s\\n' '${sedSafe.replace(/'/g, "'\\''")}' >> /var/lib/postgresql/.pgpass"`,
  );

  // Verify.
  const reprobe = (
    await exec.exec(
      "sudo -u postgres bash -c 'PGPASSFILE=/var/lib/postgresql/.pgpass psql -U fail2ban -d fail2ban -tAc \"SELECT 1\" 2>&1' || true",
    )
  ).trim();
  if (reprobe !== "1") {
    throw new Error(
      `fail2ban auth repair failed: psql still returns "${reprobe.slice(0, 120)}"`,
    );
  }
  log(stepId, "info", "fail2ban PostgreSQL auth repaired successfully.");

  // Also patch the cron line on-disk so older boxes stop spamming
  // root-mail. The slim-engine patch covers fresh installs; this covers
  // the in-place case. Idempotent (sed only matches the unredirected line).
  await exec.exec(
    `sed -i 's|/usr/local/bin/fail2ban_banned_db unban_db$|/usr/local/bin/fail2ban_banned_db unban_db >/dev/null 2>\\&1|' /etc/cron.d/iredmail 2>/dev/null || true`,
  );
}

/**
 * Step 9: Run the iRedMail installer non-interactively.
 *
 * The engine is the slimmed tree (see `apps/email/scripts/slim-engine.ts`):
 * nginx, PHP, iRedAdmin, Roundcube, SOGo, Netdata, mlmmj, MySQL backend,
 * and OpenLDAP are gone. What remains is the raw mail core - Postfix,
 * Dovecot, Amavis, ClamAV, SpamAssassin, iRedAPD, fail2ban, PostgreSQL.
 *
 * Because the engine no longer touches :80 / :443 at all, there's no need
 * to stop/restart OpenResty around the installer - the two stay running
 * side-by-side.
 *
 * Config: pre-seeded so the installer skips its dialog. The `#EOF` marker
 * is mandatory - without it, iRedMail's `check_env` says "Found, but not
 * finished" and falls through to interactive mode (which hangs in SSH).
 *
 * All generated secrets are returned in `data.secrets` so the controller
 * can persist them - the PostgreSQL root password is the only way to
 * admin the mail DB later.
 */
export async function stepRunInstaller(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
  config?: IRedMailConfig,
): Promise<StepResult> {
  const stepId = 9;
  const backend = config?.storageBackend ?? "postgresql";
  const dbBackend = backend === "postgresql" ? "PGSQL" : "MYSQL";
  const dbRootKey = backend === "postgresql" ? "PGSQL_ROOT_PASSWD" : "MYSQL_ROOT_PASSWD";

  // Admin password: operator-supplied if provided (it's the postmaster login),
  // else reused from a prior run, else freshly generated.
  const adminPassword =
    config?.adminPassword ??
    config?.prefillSecrets?.DOMAIN_ADMIN_PASSWD_PLAIN ??
    genSecret(18);

  // Only the secrets the slimmed engine actually reads. iRedAdmin /
  // Roundcube / SOGo / Netdata / MLMMJ vars are gone because their
  // consumers are gone. We keep the rest because the daemons still ship.
  //
  // Persisted secrets from a previous run win - reusing them keeps the
  // install consistent with iRedMail's on-disk configs.
  const generated: Record<string, string> = {
    DOMAIN_ADMIN_PASSWD_PLAIN: adminPassword,
    VMAIL_DB_BIND_PASSWD: genSecret(),
    VMAIL_DB_ADMIN_PASSWD: genSecret(),
    AMAVISD_DB_PASSWD: genSecret(),
    IREDAPD_DB_PASSWD: genSecret(),
    // fail2ban writes ban records to its own Postgres DB. Skipping this
    // var was a slim mistake - the daemon ships, the DB role is still
    // created, and missing-password = empty-password = auth failure.
    FAIL2BAN_DB_PASSWD: genSecret(),
    [dbRootKey]: genSecret(),
  };
  const secrets: Record<string, string> = {
    ...generated,
    ...(config?.prefillSecrets ?? {}),
  };
  // The plaintext we'll show in the dashboard. After prefillSecrets is
  // overlaid above, `secrets.DOMAIN_ADMIN_PASSWD_PLAIN` is the
  // authoritative value - use that, not the local `adminPassword` (which
  // would lose any prior-run reuse).
  const finalAdminPassword = secrets.DOMAIN_ADMIN_PASSWD_PLAIN;

  // ── Pre-flight: detect already-installed iRedMail ───────────────────
  //
  // If the user runs the wizard against a server that already has a
  // working iRedMail, the engine's `STATUS_FILE` flags every step as
  // done and SKIPs them all. The install "succeeds" instantly, but our
  // freshly-generated postmaster password never makes it into the
  // database - they keep the old one (which we don't have) and the
  // dashboard's password doesn't work.
  //
  // We catch this by checking the daemon state before running the
  // installer. If postfix + dovecot are both active, we skip the
  // engine invocation and rotate the postmaster password in the DB
  // (via doveadm + UPDATE) to match the value the dashboard is about
  // to surface. The other daemons stay untouched.
  log(stepId, "info", "Checking whether iRedMail is already installed...");
  const alreadyInstalled = await detectMailInstall(exec);

  if (alreadyInstalled) {
    log(
      stepId,
      "warn",
      "iRedMail is already installed on this server. The engine would skip every step.",
    );
    log(
      stepId,
      "info",
      "Rotating postmaster password so the dashboard matches the live database...",
    );
    try {
      await updatePostmasterPassword(exec, domain, finalAdminPassword);
    } catch (err) {
      return {
        stepId,
        success: false,
        message: `iRedMail is already installed, but the postmaster password rotation failed: ${errMsg(err)}`,
      };
    }
    // Self-heal: realign .pgpass and the PG role when they have an empty
    // password and a broken state, so root stops getting cron mail every minute.
    try {
      await repairFail2banAuth(exec, secrets.FAIL2BAN_DB_PASSWD, stepId, log);
    } catch (err) {
      log(
        stepId,
        "warn",
        `fail2ban auth repair failed (non-fatal): ${errMsg(err)}`,
      );
    }
    log(stepId, "info", "Postmaster password synced. Skipping engine reinstall.");
    return {
      stepId,
      success: true,
      message:
        "iRedMail already installed - postmaster password rotated to the dashboard value, engine reinstall skipped.",
      data: { secrets: { ...secrets } as Record<string, string> },
    };
  }

  log(stepId, "info", "Generating iRedMail config...");

  const lines = [
    "# Auto-generated by openship - DO NOT EDIT BY HAND",
    `export STORAGE_BASE_DIR='/var/vmail'`,
    `export BACKEND_ORIG='${dbBackend}'`,
    `export BACKEND='${dbBackend}'`,
    `export FIRST_DOMAIN='${domain}'`,
    // USE_FAIL2BAN is the one USE_* the slim engine still consults
    // (optional_components dispatches `fail2ban_setup` on this flag).
    `export USE_FAIL2BAN='YES'`,
    ...Object.entries(secrets).map(([k, v]) => `export ${k}='${v}'`),
    // Mandatory: without this marker iRedMail treats the config as
    // incomplete and falls into its dialog (which hangs over SSH).
    "#EOF",
    "",
  ];

  await exec.writeFile(`${REMOTE_ENGINE_DIR}/config`, lines.join("\n"));

  log(stepId, "info", "Running iRedMail installer (this takes 5-10 minutes)...");

  // AUTO_* env vars short-circuit every `read_setting` prompt in the
  // engine. They MUST be a command prefix on the same line as
  // `bash iRedMail.sh` so they're exported to that process - joining
  // them with " && " makes them shell-local assignments that the
  // sub-bash never sees, and the installer hangs at the first prompt.
  //
  // Values: `y` accepts iRedMail's default (use the config file, install
  // without confirm, remove sendmail). `n` declines (don't touch host
  // firewall - openship owns that, don't replace MySQL config - we're
  // on Postgres).
  const envPrefix = [
    "AUTO_USE_EXISTING_CONFIG_FILE=y",
    "AUTO_INSTALL_WITHOUT_CONFIRM=y",
    "AUTO_CLEANUP_REMOVE_SENDMAIL=y",
    "AUTO_CLEANUP_REPLACE_FIREWALL_RULES=n",
    "AUTO_CLEANUP_RESTART_FIREWALL=n",
    "AUTO_CLEANUP_REPLACE_MYSQL_CONFIG=n",
  ].join(" ");

  const installer = await streamCmd(
    exec,
    `cd ${REMOTE_ENGINE_DIR} && ${envPrefix} bash iRedMail.sh 2>&1`,
    stepId, log,
  );
  if (installer.code !== 0) {
    log(stepId, "error", `Installer exited with code ${installer.code}`);
    return {
      stepId,
      success: false,
      message: "iRedMail installer failed. Check logs above.",
    };
  }

  log(stepId, "info", "iRedMail installer completed");

  // Post-install verification: confirm fail2ban can actually auth against
  // its Postgres DB. The engine's own setup is supposed to leave this
  // working, but if the password ever drifts (a re-run with new secrets,
  // a partial install, etc.) the every-minute cron will spam root mail
  // forever. Run the same repair we use on already-installed boxes - it's
  // a no-op when auth is already healthy.
  try {
    await repairFail2banAuth(exec, secrets.FAIL2BAN_DB_PASSWD, stepId, log);
  } catch (err) {
    log(
      stepId,
      "warn",
      `fail2ban post-install auth check failed (non-fatal): ${errMsg(err)}`,
    );
  }

  return {
    stepId,
    success: true,
    message: "iRedMail installed successfully",
    data: { secrets: { ...secrets } as Record<string, string> },
  };
}

/** Step 10: Reboot server and wait for reconnection */
export async function stepReboot(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
  reconnectFn: () => Promise<CommandExecutor>,
): Promise<StepResult> {
  const stepId = 10;
  log(stepId, "info", "Rebooting server...");

  // Fire-and-forget reboot (will drop connection)
  exec.exec("sleep 2 && reboot").catch(() => {});

  log(stepId, "info", "Waiting 30 seconds for server to restart...");
  await sleep(30_000);

  log(stepId, "info", "Attempting to reconnect...");
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(stepId, "info", `Reconnection attempt ${attempt}/${maxAttempts}...`);
    try {
      const newExec = await reconnectFn();
      const out = await newExec.exec("echo connected");
      if (out.trim() === "connected") {
        log(stepId, "info", "Reconnected successfully");
        return { stepId, success: true, message: "Server rebooted and reconnected" };
      }
    } catch {
      // Expected during reboot
    }
    await sleep(10_000);
  }

  return { stepId, success: false, message: "Failed to reconnect after reboot" };
}

/**
 * Compose the SPF TXT value. Emits the strictest practical form:
 *
 *   v=spf1 mx [ip4:<v4>] [ip6:<v6>] -all
 *
 *   - `mx`: authorizes whatever the domain's MX target resolves to. Self-
 *     repairing if the mail host's IP ever changes - no SPF edit needed.
 *   - `ip4:` / `ip6:`: explicit IPs of the mail host. Redundant with `mx`
 *     but lets receivers authorize without an MX lookup, and is robust
 *     against transient DNS failures on the MX target. Included only
 *     when we actually detected the host's IPs.
 *   - `-all` (hardfail): anything not on the list MUST be rejected.
 *     Gives spoof attempts no soft-landing. The DMARC quarantine policy
 *     we also publish handles the few legitimate edge cases.
 *
 * Exported so the admin/domain-dns.service can emit the exact same SPF
 * shape when adding additional domains to the mail server.
 */
export function buildSpfValue(
  ipv4?: string | null,
  ipv6?: string | null,
): string {
  const parts: string[] = ["v=spf1", "mx"];
  if (ipv4) parts.push(`ip4:${ipv4}`);
  if (ipv6) parts.push(`ip6:${ipv6}`);
  parts.push("-all");
  return parts.join(" ");
}

/** Step 11: Retrieve DKIM keys and build DNS record instructions */
export async function stepDkimKeys(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const mailDomain = `mail.${domain}`;
  log(11, "info", "Locating amavis binary...");

  // Debian renamed the binary between Ubuntu 22.04 (jammy: `amavisd-new`)
  // and 24.04 (noble: `amavisd`). The package name (`amavisd-new`) stays
  // the same on both, so checking the package is no help - we have to
  // probe for whichever binary actually exists. iRedMail's own engine
  // does the same dispatch in `conf/amavisd`.
  const probe = await exec.exec(
    "if command -v amavisd >/dev/null 2>&1; then echo amavisd; " +
      "elif command -v amavisd-new >/dev/null 2>&1; then echo amavisd-new; " +
      "else echo MISSING; fi",
  );
  const amavisBin = probe.trim();
  if (amavisBin === "MISSING") {
    return {
      stepId: 11,
      success: false,
      message:
        "Neither `amavisd` (Ubuntu 24.04) nor `amavisd-new` (Ubuntu 22.04) is on PATH. The amavisd-new package may not have installed.",
    };
  }
  log(11, "info", `Using ${amavisBin}`);

  log(11, "info", "Retrieving DKIM keys...");
  let rawOutput: string;
  try {
    rawOutput = await exec.exec(`${amavisBin} showkeys 2>&1`);
  } catch (err) {
    return { stepId: 11, success: false, message: `Failed to retrieve DKIM keys: ${errMsg(err)}` };
  }

  if (!rawOutput) {
    return { stepId: 11, success: false, message: "Empty DKIM output" };
  }

  // Extract the TXT record value from between quotes
  const matches = rawOutput.match(/"([^"]+)"/g);
  const dkimValue = matches
    ? matches.map((m: string) => m.replace(/"/g, "")).join("").replace(/\s+/g, "")
    : "";

  if (!dkimValue) {
    return { stepId: 11, success: false, message: "Could not parse DKIM key from output" };
  }

  // ── Detect server's public IPs ──────────────────────────────────────
  //
  // Surfaced in two places:
  //   1. The DNS banner: as `A` (required) and `AAAA` (recommended) records
  //      pointing `mail.<domain>` at the right IP.
  //   2. The PTR banner: as the reverse-DNS targets the user needs to
  //      configure at their VPS provider (NOT their DNS provider - common
  //      confusion).
  //
  // Uses ipify.org as the source-of-truth for "what does the world see"
  // - more reliable than parsing `ip addr` when the host has multiple
  // interfaces or is behind a one-to-one NAT. Falls back to empty on
  // network failure; we just hide the corresponding card.
  log(11, "info", "Detecting server's public IPs...");
  const detectedIpv4 = (
    await exec.exec(
      "curl -4 -s --max-time 5 https://api.ipify.org 2>/dev/null || true",
    )
  ).trim();
  const detectedIpv6 = (
    await exec.exec(
      "curl -6 -s --max-time 5 https://api64.ipify.org 2>/dev/null || true",
    )
  ).trim();
  const ipv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(detectedIpv4) ? detectedIpv4 : null;
  const ipv6 =
    detectedIpv6.includes(":") && /^[0-9a-f:]+$/i.test(detectedIpv6)
      ? detectedIpv6
      : null;
  if (ipv4) log(11, "info", `IPv4: ${ipv4}`);
  if (ipv6) log(11, "info", `IPv6: ${ipv6}`);
  if (!ipv4) log(11, "warn", "Could not detect IPv4 - A record card will be hidden.");

  // Records the user should publish.
  //
  // The required set: A, MX, SPF, DKIM, DMARC. The A record IS already in
  // place by this point (SSL cert step 12 wouldn't have got this far
  // otherwise), but we surface it as a card anyway so the user has a
  // single source of truth in the dashboard - handy if they're auditing
  // their DNS or migrating providers.
  //
  // We intentionally do NOT recommend autodiscover/autoconfig CNAMEs:
  // they only help when paired with an XML responder, which openship
  // doesn't ship; without it they only mislead. SRV records (RFC 6186)
  // are similarly omitted - `_imaps._tcp` / `_submission._tcp` are
  // honoured by ~nobody in practice.
  const dnsRecords: Record<string, unknown> = {
    ...(ipv4 && {
      a: {
        type: "A",
        name: mailDomain,
        value: ipv4,
        required: true,
      },
    }),
    ...(ipv6 && {
      aaaa: {
        type: "AAAA",
        name: mailDomain,
        value: ipv6,
        required: false,
      },
    }),
    mx: {
      type: "MX",
      name: domain,
      priority: 10,
      value: mailDomain,
      required: true,
    },
    spf: {
      type: "TXT",
      name: domain,
      value: buildSpfValue(ipv4, ipv6),
      required: true,
    },
    dkim: {
      type: "TXT",
      name: `dkim._domainkey.${domain}`,
      value: dkimValue,
      required: true,
    },
    dmarc: {
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`,
      required: true,
    },
  };

  log(11, "info", "DKIM keys retrieved - DNS records ready");
  return {
    stepId: 11,
    success: true,
    message: "DKIM keys retrieved",
    data: { dnsRecords, rawOutput },
  };
}

/**
 * Provision a DKIM keypair for an additional domain (one added via the
 * admin panel after the primary install). Mirrors what step 11 does for
 * the primary domain, but scoped to a single new domain that gets
 * appended to the existing amavis setup.
 *
 * Sequence:
 *   1. Probe amavis binary (`amavisd` on noble, `amavisd-new` on jammy).
 *   2. `amavisd genrsa /var/lib/dkim/<domain>.pem` - generates the keypair.
 *   3. Read /etc/amavis/conf.d/50-user, append the `dkim_key('<domain>', …)`
 *      directive + the per-domain entry in
 *      `@dkim_signature_options_bysender_maps`, write it back. All string
 *      manipulation happens in JS - no shell escaping, no `perl -i`.
 *   4. Reload amavis so the new key + sign-options take effect.
 *   5. `amavisd showkeys <domain>` to extract the public-key TXT value.
 *
 * Returns the `v=DKIM1; p=…` TXT-record value the operator publishes at
 * `dkim._domainkey.<domain>`.
 */
export async function provisionDomainDkim(
  exec: CommandExecutor,
  newDomain: string,
): Promise<string> {
  // ── Step 1: pick the right amavis binary ─────────────────────────────
  const probe = await exec.exec(
    "if command -v amavisd >/dev/null 2>&1; then echo amavisd; " +
      "elif command -v amavisd-new >/dev/null 2>&1; then echo amavisd-new; " +
      "else echo MISSING; fi",
  );
  const amavisBin = probe.trim();
  if (amavisBin === "MISSING") {
    throw new Error(
      "Neither `amavisd` nor `amavisd-new` is installed - can't provision DKIM.",
    );
  }

  // ── Step 2: generate the keypair ─────────────────────────────────────
  const keyPath = `/var/lib/dkim/${newDomain}.pem`;
  await exec.exec(`mkdir -p /var/lib/dkim`);
  // amavisd genrsa exits non-zero if the file already exists; treat that
  // as success so re-runs are idempotent.
  await exec.exec(
    `[ -s ${sq(keyPath)} ] || ${amavisBin} genrsa ${sq(keyPath)}`,
  );
  await exec.exec(`chown -R amavis:amavis /var/lib/dkim 2>/dev/null || true`);

  // ── Step 3: splice the directive + sign-options entry into 50-user ───
  const confPath = "/etc/amavis/conf.d/50-user";
  const existing = await exec.readFile(confPath).catch(() => "");
  const dkimKeyLine = `dkim_key('${newDomain}', 'dkim', '${keyPath}');`;
  const signEntry = `   '.${newDomain}'  => { d => '${newDomain}', a => 'rsa-sha256', ttl => 21*24*3600 },`;
  const next = spliceAmavisConf(existing, newDomain, dkimKeyLine, signEntry);
  if (next !== existing) {
    await exec.writeFile(confPath, next);
  }

  // ── Step 4: reload amavis ────────────────────────────────────────────
  await exec.exec(
    "systemctl reload amavis 2>/dev/null || systemctl reload amavisd 2>/dev/null || " +
      "systemctl restart amavis 2>/dev/null || systemctl restart amavisd 2>/dev/null || true",
  );

  // ── Step 5: read the public key out ──────────────────────────────────
  const showOutput = await exec.exec(`${amavisBin} showkeys ${sq(newDomain)} 2>&1`);
  const matches = showOutput.match(/"([^"]+)"/g);
  const dkimValue = matches
    ? matches.map((m: string) => m.replace(/"/g, "")).join("").replace(/\s+/g, "")
    : "";
  if (!dkimValue) {
    throw new Error(
      `Could not parse DKIM key from \`${amavisBin} showkeys ${newDomain}\` output: ${showOutput.slice(0, 200)}`,
    );
  }
  return dkimValue;
}

/**
 * Pure helper for editing /etc/amavis/conf.d/50-user. Adds the two
 * directives the per-domain key needs, idempotently.
 *
 *   - `dkim_key(...)` - appended at the end of the file if not already
 *     present (matched by substring on the exact key file path).
 *   - `'.<domain>' => { d => ..., a => ..., ttl => ... }` - spliced
 *     inside the `@dkim_signature_options_bysender_maps = ( ( … ) );`
 *     block, just before the inner closing `)`. iRedMail's primary
 *     install writes that array during the original step 11, so the
 *     block is always present.
 *
 * Returns the new file content (or the original string if nothing
 * changed, so the caller can skip the write).
 */
export function spliceAmavisConf(
  conf: string,
  newDomain: string,
  dkimKeyLine: string,
  signEntry: string,
): string {
  let out = conf;

  if (!out.includes(dkimKeyLine)) {
    if (out.length > 0 && !out.endsWith("\n")) out += "\n";
    out += `${dkimKeyLine}\n`;
  }

  // Detect "already in the bysender map" via a substring check that won't
  // false-positive on e.g. an apostrophe in a comment.
  const senderMarker = `'.${newDomain}'`;
  if (!out.includes(senderMarker)) {
    // Find the line where the bysender map opens, then the matching
    // inner `)` (the one that closes the first sub-list), and splice the
    // new entry before it.
    const openRe = /@dkim_signature_options_bysender_maps\s*=\s*\(/;
    const m = openRe.exec(out);
    if (m) {
      // Walk forward from the open and find the matching closing `)` of
      // the OUTER list. iRedMail's format is:
      //   @dkim_signature_options_bysender_maps = ( {
      //     '.example.com' => { ... },
      //     ...
      //   } );
      // We splice just before the closing `}`, inside the hash.
      const startIdx = m.index + m[0].length;
      let depth = 1;
      let i = startIdx;
      while (i < out.length && depth > 0) {
        const ch = out[i];
        if (ch === "(" || ch === "{") depth++;
        else if (ch === ")" || ch === "}") {
          depth--;
          if (depth === 0) break;
        }
        i++;
      }
      // i now points at the outer-closing char of the block.
      // Backtrack to the start of that line so the splice indents cleanly.
      let lineStart = i;
      while (lineStart > 0 && out[lineStart - 1] !== "\n") lineStart--;
      out = `${out.slice(0, lineStart)}${signEntry}\n${out.slice(lineStart)}`;
    }
    // If the marker is missing entirely (not the iRedMail format we expect),
    // we silently skip - the `dkim_key` directive alone is enough for
    // amavis to load the key; signing for the new domain just won't kick
    // in until the operator wires up that map manually.
  }

  return out;
}

/**
 * Step 12: Request a Let's Encrypt cert for `mail.<domain>`.
 *
 * Webroot mode through the RUNNING OpenResty: its default server already serves
 * `/.well-known/acme-challenge/` from `/var/www/acme` (deployLuaScripts), so the
 * HTTP-01 challenge is answered without ever stopping OpenResty. This is what
 * keeps every app behind the shared edge UP during mail cert issuance — the old
 * `systemctl stop openresty` + `--standalone` dance took the whole box dark.
 */
export async function stepRequestSSL(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 12;
  const mailDomain = `mail.${domain}`;
  // Guard before the value reaches a shell command (never interpolate an
  // unvalidated hostname into `certbot -d …`).
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(mailDomain)) {
    return { stepId, success: false, message: `Invalid mail domain: ${mailDomain}` };
  }
  log(stepId, "info", `Requesting SSL certificate for ${mailDomain}...`);

  // OpenResty's default server serves the challenge from here — no stop needed.
  await exec.exec("mkdir -p /var/www/acme");
  const cert = await streamCmd(
    exec,
    `certbot certonly --webroot -w /var/www/acme --agree-tos --register-unsafely-without-email -d ${sq(mailDomain)} --non-interactive 2>&1`,
    stepId, log,
  );

  if (cert.code !== 0) {
    return {
      stepId,
      success: false,
      message: "Failed to obtain SSL certificate. Check logs above.",
    };
  }

  log(stepId, "info", "SSL certificate obtained (OpenResty stayed up — apps unaffected)");
  return { stepId, success: true, message: `SSL certificate obtained for ${mailDomain}` };
}

/**
 * Step 13: Link Let's Encrypt certs into the paths Postfix/Dovecot expect,
 * then reload the mail daemons. No reboot - a daemon reload is sufficient
 * and orders of magnitude faster.
 *
 * `reconnectFn` is unused now but kept in the signature so the controller's
 * key-based dispatch (which treats this step as a "reboot" type) keeps
 * working; the dispatch will be tightened in a follow-up.
 */
export async function stepConfigureSSL(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
  _reconnectFn: () => Promise<CommandExecutor>,
): Promise<StepResult> {
  const stepId = 13;
  const mailDomain = `mail.${domain}`;

  log(stepId, "info", "Setting Let's Encrypt directory permissions...");
  await exec.exec("chmod 0755 /etc/letsencrypt/live /etc/letsencrypt/archive");

  log(stepId, "info", "Backing up existing iRedMail self-signed certificates...");
  await exec.exec("mv /etc/ssl/certs/iRedMail.crt /etc/ssl/certs/iRedMail.crt.bak 2>/dev/null || true");
  await exec.exec("mv /etc/ssl/private/iRedMail.key /etc/ssl/private/iRedMail.key.bak 2>/dev/null || true");

  log(stepId, "info", "Linking Let's Encrypt certificates into mail daemon paths...");
  await exec.exec(
    `ln -sf /etc/letsencrypt/live/${mailDomain}/fullchain.pem /etc/ssl/certs/iRedMail.crt`,
  );
  await exec.exec(
    `ln -sf /etc/letsencrypt/live/${mailDomain}/privkey.pem /etc/ssl/private/iRedMail.key`,
  );

  log(stepId, "info", "Reloading mail daemons to pick up new certificates...");
  // Best-effort: a missing service is fine (e.g. Postfix not yet enabled),
  // we only care that the running ones reload their TLS context.
  await exec.exec("systemctl reload postfix 2>/dev/null || true");
  await exec.exec("systemctl reload dovecot 2>/dev/null || true");

  log(stepId, "info", "Mail setup complete!");
  return {
    stepId,
    success: true,
    message: "SSL configured and mail daemons reloaded",
    data: {
      mailDomain,
      smtpHost: mailDomain,
      imapHost: mailDomain,
    },
  };
}

// ─── Step runner map ─────────────────────────────────────────────────────────

export type BasicStepFn = (
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
) => Promise<StepResult>;

export type RebootStepFn = (
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
  reconnectFn: () => Promise<CommandExecutor>,
) => Promise<StepResult>;

export type InstallerStepFn = (
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
  config?: IRedMailConfig,
) => Promise<StepResult>;

export const STEP_RUNNERS: Record<
  number,
  BasicStepFn | RebootStepFn | InstallerStepFn
> = {
  1: stepSystemUpdate,
  2: stepEnsureComponents,
  3: stepCheckPort25,
  4: stepEnsureReverseProxy,
  5: stepSetHostname,
  6: stepUpdateHosts,
  7: stepTransferEngine,
  8: stepPrepareEngine,
  9: stepRunInstaller,
  10: stepReboot,
  11: stepDkimKeys,
  12: stepRequestSSL,
  13: stepConfigureSSL,
};


