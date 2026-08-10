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

import { randomBytes } from "node:crypto";
import type { CommandExecutor, SystemLogCallback, SystemLog } from "@repo/adapters";
import { checkMailHealth } from "./mail-health.service";
import { safeErrorMessage } from "@repo/core";
import {
  installDocker,
  installContainerEdge,
  ensureEdge,
  foreignProxyOnEdge,
  ensureContainerMail,
  MAIL_CONTAINER,
  MAIL_PORTS,
} from "@repo/adapters";
import {
  mailConfigFile,
  mailEngineCommand,
  mailUnitActionCommand,
  requireMailEngine,
  type MailEngineFlavor,
} from "./mail-engine";

// ─── Shell quoting helper ─────────────────────────────────────────────────────

/** Single-quote a value for safe shell interpolation. */
function sq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ─── Engine source-of-truth ──────────────────────────────────────────────────

// ─── Helpers ─────────────────────────────────────────────────────────────────

function errMsg(err: unknown): string {
  return safeErrorMessage(err);
}

/**
 * The amavis half of the topology, resolved once per operation.
 *
 * Two things vary by flavor and nothing else does: WHERE amavis commands run
 * (inside the engine vs on the host) and which side of the `50-user` bind mount we
 * edit. `mailEngineCommand` / `mailConfigFile` own both — see `./mail-engine.ts`.
 * The binary name varies by DISTRO, not by flavor (`amavisd` on noble,
 * `amavisd-new` on jammy), so it stays a probe on both.
 *
 * Goes through `requireMailEngine`, so DKIM work on a box with no engine — or a
 * stopped one, which can't genrsa or reload — fails as a typed 409 with a
 * remediation instead of a raw "No such container".
 */
async function resolveAmavis(exec: CommandExecutor): Promise<{
  flavor: MailEngineFlavor;
  /** `amavisd` or `amavisd-new`, whichever this engine actually has. */
  bin: string;
  /** Wrap a command so it runs where amavis lives. */
  run: (cmd: string) => string;
  /** `50-user`: `write` = the path to edit, `engine` = the path amavis reads. */
  conf: { write: string; engine: string };
}> {
  const { flavor } = await requireMailEngine(exec);
  const run = (cmd: string) => mailEngineCommand(flavor, cmd);
  const detect =
    "if command -v amavisd >/dev/null 2>&1; then echo amavisd; " +
    "elif command -v amavisd-new >/dev/null 2>&1; then echo amavisd-new; " +
    "else echo MISSING; fi";
  const probe = await exec.exec(run(`sh -c ${sq(detect)}`));
  const bin = probe.trim().split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
  if (!bin || bin === "MISSING") {
    throw new Error(
      flavor === "container"
        ? "Neither `amavisd` nor `amavisd-new` is on PATH inside the mail engine container."
        : "Neither `amavisd` nor `amavisd-new` is on PATH on this mail server.",
    );
  }
  return { flavor, bin, run, conf: mailConfigFile(flavor, "amavisUserConf") };
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
  ensure_components:   15 * 60_000,   // Docker install + edge image pull
  check_port_25:        30_000,
  ensure_reverse_proxy: 30_000,
  open_firewall:        60_000,
  deploy_engine:       15 * 60_000,   // pull engine + sidecar images, first-boot init
  dkim_keys:            60_000,
  request_ssl:          5 * 60_000,
  configure_ssl:        2 * 60_000,
};

/** Fallback when a step key isn't in the map. Never used as long as the map stays in sync. */
export const DEFAULT_STEP_TIMEOUT_MS = 10 * 60_000;

// The containerized flow: the mail engine is a PREBUILT image, so the old
// host-native install steps (apt upgrade, set hostname, /etc/hosts, rsync the
// engine, run iRedMail.sh, reboot) are gone — the box is just a Docker + edge
// host. What remains is either runtime-specific (firewall, DKIM/DNS, cert) or
// per-install (domain + secrets, injected into the engine's first boot).
export const MAIL_SETUP_STEPS: MailSetupStep[] = [
  { id: 1, key: "ensure_components",    label: "Ensure System Components",  description: "Install Docker and bring up the openship edge" },
  { id: 2, key: "check_port_25",        label: "Check Port 25",             description: "Verify outbound SMTP port is open" },
  { id: 3, key: "ensure_reverse_proxy", label: "Ensure Reverse Proxy",      description: "Confirm the openship edge owns ports 80/443" },
  { id: 4, key: "open_firewall",        label: "Open Mail Firewall",        description: "Open inbound SMTP/IMAP/submission ports on the host firewall" },
  { id: 5, key: "deploy_engine",        label: "Deploy Mail Engine",        description: "Pull and run the openship-mail engine container + database sidecar" },
  { id: 6, key: "dkim_keys",            label: "Retrieve DKIM Keys",        description: "Get DKIM keys and DNS records" },
  { id: 7, key: "request_ssl",          label: "Request SSL Certificate",   description: "Obtain Let's Encrypt SSL for mail domain" },
  { id: 8, key: "configure_ssl",        label: "Configure SSL",             description: "Link certificates and reload mail daemons" },
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

/** Step 2: Check outbound port 25 */
export async function stepCheckPort25(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 2;
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
 * Step 1: Ensure Docker and the openship edge are on the target.
 *
 *   - Docker → the mail engine + edge are container images, so it's a hard prereq
 *   - edge   → routing + TLS for this box: OpenResty, its Lua, and certbot, all
 *              inside the `openship-edge` image
 *
 * There is ONE edge on a box and it is the container. This step used to
 * apt-install a HOST OpenResty and certbot, which made mail the only flow with
 * its own edge story: a second implementation to keep in sync, its own conflict
 * handling, and a certbot on the host that step 12 then shelled out to while
 * every other cert in the system was issued through the edge's.
 *
 * So it goes through `ensureEdge` → {@link installContainerEdge}, the same
 * orchestrator the deploy pipeline, server-setup, and the Domains tab use.
 * Deliberately NO host fallback: a Docker-less box gets `installContainerEdge`'s
 * own actionable failure rather than a divergent edge that then has to be
 * migrated. Both installers are idempotent, so a re-run is cheap.
 *
 * No `promptUser` is passed, so a foreign proxy on :80/:443 surfaces as a plain
 * failure (see `ensureEdgeClear`) instead of the interactive migrate hold the
 * deploy pipeline offers. Mail never blind-takes-over someone's proxy; the
 * operator migrates it from the dashboard and reruns. Wiring the consent prompt
 * into the mail SSE later is a drop-in at this call site.
 */
export async function stepEnsureComponents(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 1;
  const sysLog = bridgeToSystemLog(stepId, log);

  for (const [name, install] of [["Docker", installDocker]] as const) {
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

  log(stepId, "info", "Ensuring the openship edge (OpenResty + certbot, containerized)...");
  const edge = await ensureEdge(
    exec,
    (promptUser) => installContainerEdge(exec, sysLog, { promptUser }),
    { onLog: sysLog },
  );

  // `migrated` means a foreign proxy was imported and 80/443 taken over. Only
  // reachable once this call site passes a promptUser, but handled now so adding
  // one can't silently report a rolled-back migration as success.
  if (edge.migrated) {
    return edge.ok
      ? { stepId, success: true, message: "Docker and the edge are ready (migrated the existing proxy)" }
      : {
          stepId,
          success: false,
          message: "Edge migration failed - rolled back to the previous proxy.",
        };
  }

  if (!edge.value.success) {
    return {
      stepId,
      success: false,
      message: `Edge install failed: ${edge.value.error ?? "unknown error"}`,
    };
  }

  log(stepId, "info", `Edge ready${edge.value.version ? ` (OpenResty ${edge.value.version})` : ""}`);
  return {
    stepId,
    success: true,
    message: "Docker and the openship edge are ready",
  };
}

/**
 * Step 4: Confirm OUR edge holds :80 / :443.
 *
 * Pure verification — step 2 is what brings the edge up. There is no host
 * `openresty.service` to check or start any more: the edge is a container, and
 * starting/stopping it is `ensureContainerEdge`'s business, not a step that
 * shells out to systemd behind its back.
 *
 * Answered by the SHARED edge detector (`probeEdge`, same one the deploy pipeline
 * and self-app use), never an ad-hoc `ss`/regex, so "ours" means exactly what it
 * means everywhere else.
 */
export async function stepEnsureReverseProxy(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 3;

  log(stepId, "info", "Checking which proxy holds :80 / :443...");
  const { status, blocked, owner } = await foreignProxyOnEdge(exec);

  // A foreign proxy is surfaced as an error, never taken over: mail doesn't have
  // the interactive migrate hold, so the operator migrates it from the dashboard
  // (which does) and reruns.
  if (blocked) {
    return {
      stepId,
      success: false,
      message: `Ports 80/443 are held by another proxy (${owner}). Stop it, or migrate it from the dashboard, then rerun.`,
    };
  }

  // "free" = nothing is serving. Not a conflict — the edge simply isn't up, which
  // means step 2 didn't complete (or the container has since been removed). Say
  // that, rather than passing a box no cert challenge could reach.
  if (status.classification === "free") {
    return {
      stepId,
      success: false,
      message:
        "Nothing is listening on :80 / :443 - the openship edge isn't running. " +
        "Rerun from \"Ensure System Components\" to bring it up.",
    };
  }

  log(stepId, "info", "The openship edge holds :80 / :443");
  return { stepId, success: true, message: "The openship edge is the active reverse proxy" };
}

/**
 * Step 4: Open the inbound mail ports on the host firewall.
 *
 * The engine now runs `--network host`, and unlike a bridge port-publish Docker
 * does NOT poke the firewall for a host-networked container — so a box with ufw
 * enabled would silently accept no mail on :25/:587/:993. The old outbound-:25
 * probe (step 3) only proves egress; this opens ingress. Best-effort across ufw
 * and raw iptables so it works whether or not ufw is the front-end, and a no-op
 * when neither is active.
 */
export async function stepOpenMailFirewall(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 4;
  log(stepId, "info", `Opening inbound mail ports: ${MAIL_PORTS.join(", ")}...`);

  const ufwActive = (
    await exec.exec("ufw status 2>/dev/null | head -1 || true").catch(() => "")
  ).includes("Status: active");

  for (const port of MAIL_PORTS) {
    if (ufwActive) {
      await exec.exec(`ufw allow ${port}/tcp 2>/dev/null || true`).catch(() => {});
    } else {
      // Idempotent: check-then-insert so a re-run doesn't stack duplicate rules.
      await exec
        .exec(
          `iptables -C INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || ` +
            `iptables -I INPUT -p tcp --dport ${port} -j ACCEPT 2>/dev/null || true`,
        )
        .catch(() => {});
    }
  }

  log(stepId, "info", ufwActive ? "Opened via ufw" : "Opened via iptables (or firewall inactive)");
  return { stepId, success: true, message: "Inbound mail ports opened" };
}

/** Random URL-safe secret. iRedMail's installer treats these as opaque strings. */
export function genSecret(bytes = 24): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Step 5: Deploy the mail engine as the `openship-mail` container + pg sidecar.
 *
 * The iRedMail install itself is baked into the prebuilt image, so this step no
 * longer runs `iRedMail.sh` — it generates the per-install secrets, hands them +
 * the domain to `ensureContainerMail` (which pulls, runs host-networked, and lets
 * the image's first-boot entrypoint provision the vmail DB), then health-gates on
 * the container's daemons. Idempotent: a container already on the pinned image is
 * left as-is. Generated secrets come back in `data.secrets` (the only way to admin
 * the mail DB later) and the deployed image ref + container name in `data.engine`,
 * both for the controller to persist onto the mail-state.
 */
export async function stepDeployEngine(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
  config?: IRedMailConfig,
): Promise<StepResult> {
  const stepId = 5;
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

  // finalAdminPassword is the postmaster password the dashboard surfaces; it's
  // injected into the engine's first-boot env so the container provisions the
  // account with it. Referenced via `secrets` below.
  void finalAdminPassword;

  // Deploy the engine as the `openship-mail` container (+ postgres sidecar).
  // Idempotent: a container already running the pinned image is left as-is (the
  // env-file secrets are only consumed on first boot, so a re-run never rotates a
  // live DB); a different image triggers a rollback-guarded swap. This REPLACES the
  // old host-native `iRedMail.sh` run — the engine's own first-boot entrypoint does
  // the iRedMail provisioning inside the image against the sidecar DB.
  log(stepId, "info", "Deploying the mail engine container...");
  let engine: { image: string; container: string };
  try {
    const result = await ensureContainerMail(exec, {
      domain,
      secrets,
      onLog: bridgeToSystemLog(stepId, log),
      // The engine image is delivered before this call (deliverManagedImage in the
      // deploy_engine step) — dev builds on the control plane and ships to the box,
      // prod pulls; ensureContainerMail just runs whatever tag is already present.
    });
    if (result.mailDown) {
      return {
        stepId,
        success: false,
        message: "Mail engine update failed and rollback also failed — no engine is running.",
      };
    }
    engine = { image: result.image, container: result.container };
  } catch (err) {
    return { stepId, success: false, message: `Mail engine deploy failed: ${errMsg(err)}` };
  }

  // Health-gate on the daemons the container actually reports (via supervisorctl),
  // so a container that starts but whose Postfix/Dovecot never come up is a failure
  // here, not a mystery two steps later.
  const health = await checkMailHealth(exec).catch(() => null);
  if (health) {
    // Only the mail-path daemons gate the deploy; ClamAV/freshclam can still be
    // warming up (large signature load) without blocking a working mail server.
    const CRITICAL = new Set(["postfix", "dovecot", "postgresql"]);
    const down = health.filter((c) => CRITICAL.has(c.key) && c.status !== "active");
    if (down.length > 0) {
      return {
        stepId,
        success: false,
        message: `Mail engine started but these components are not running: ${down
          .map((c) => c.label)
          .join(", ")}.`,
      };
    }
  }

  log(stepId, "info", "Mail engine container running");
  return {
    stepId,
    success: true,
    message: "Mail engine deployed",
    data: { secrets: { ...secrets } as Record<string, string>, engine },
  };
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
  log(6, "info", "Locating amavis binary...");

  let amavis: Awaited<ReturnType<typeof resolveAmavis>>;
  try {
    amavis = await resolveAmavis(exec);
  } catch (err) {
    return { stepId: 6, success: false, message: errMsg(err) };
  }
  const amavisBin = amavis.run(amavis.bin);
  log(
    6,
    "info",
    amavis.flavor === "container" ? `Using ${amavis.bin} (in ${MAIL_CONTAINER})` : `Using ${amavis.bin}`,
  );

  log(6, "info", "Retrieving DKIM keys...");
  let rawOutput: string;
  try {
    rawOutput = await exec.exec(`${amavisBin} showkeys 2>&1`);
  } catch (err) {
    return { stepId: 6, success: false, message: `Failed to retrieve DKIM keys: ${errMsg(err)}` };
  }

  if (!rawOutput) {
    return { stepId: 6, success: false, message: "Empty DKIM output" };
  }

  // Extract the TXT record value from between quotes
  const matches = rawOutput.match(/"([^"]+)"/g);
  const dkimValue = matches
    ? matches.map((m: string) => m.replace(/"/g, "")).join("").replace(/\s+/g, "")
    : "";

  if (!dkimValue) {
    return { stepId: 6, success: false, message: "Could not parse DKIM key from output" };
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
  log(6, "info", "Detecting server's public IPs...");
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
  if (ipv4) log(6, "info", `IPv4: ${ipv4}`);
  if (ipv6) log(6, "info", `IPv6: ${ipv6}`);
  if (!ipv4) log(6, "warn", "Could not detect IPv4 - A record card will be hidden.");

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

  log(6, "info", "DKIM keys retrieved - DNS records ready");
  return {
    stepId: 6,
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
 *   1. Resolve amavis: which binary (`amavisd` on noble, `amavisd-new` on jammy)
 *      and where it runs — `resolveAmavis` keeps that the only flavor-aware bit.
 *   2. `amavisd genrsa /var/lib/dkim/<domain>.pem` - generates the keypair.
 *   3. Read 50-user, append the `dkim_key('<domain>', …)` directive + the
 *      per-domain entry in `@dkim_signature_options_bysender_maps`, write it back.
 *      All string manipulation happens in JS - no shell escaping, no `perl -i`.
 *      The path written is the host side of the bind mount; the path INSIDE the
 *      directive is what amavis itself reads.
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
  // ── Step 1: resolve where amavis lives + which binary it ships ─────────
  const { bin, run, conf, flavor } = await resolveAmavis(exec);
  const amavisBin = run(bin);

  // ── Step 2: generate the keypair (engine-side path; bind-mounted on container) ─
  const keyPath = `/var/lib/dkim/${newDomain}.pem`;
  await exec.exec(run("mkdir -p /var/lib/dkim"));
  // genrsa exits non-zero if the file already exists; treat that as success.
  await exec.exec(run(`sh -c ${sq(`[ -s ${keyPath} ] || ${bin} genrsa ${keyPath}`)}`));
  await exec.exec(run("chown -R amavis:amavis /var/lib/dkim")).catch(() => {});

  // ── Step 3: splice the directive into 50-user (the writable side) ───────
  const confPath = conf.write;
  const existing = await exec.readFile(confPath).catch(() => "");
  const dkimKeyLine = `dkim_key('${newDomain}', 'dkim', '${keyPath}');`;
  const signEntry = `   '.${newDomain}'  => { d => '${newDomain}', a => 'rsa-sha256', ttl => 21*24*3600 },`;
  const next = spliceAmavisConf(existing, newDomain, dkimKeyLine, signEntry);
  if (next !== existing) {
    await exec.writeFile(confPath, next);
  }

  // ── Step 4: reload amavis so the new key is signed with ──────────────
  await exec.exec(mailUnitActionCommand(flavor, "amavis", "amavis", "restart")).catch(() => {});

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
 * Delegates to the SAME `platform.ssl` every other certificate in the system goes
 * through — the pattern `registerWebmailCloudProxy` already uses against this very
 * mail VPS. This used to invoke `certbot certonly --standalone` itself, with a
 * comment saying it was "the same ACME mechanism the rest of openship uses": it
 * imitated `NginxProvider.provisionCert` instead of calling it, so the two could
 * drift, and it ran certbot on the HOST — which broke outright once the edge became
 * a container, because certbot then lives inside the image and the host has none.
 *
 * What comes free by delegating: execution on the right side of the container
 * boundary, `--cert-name` lineage pinning (a stale renewal config would otherwise
 * push the cert to `<domain>-0001`, where step 13's symlinks would never find it),
 * `ensureIssued`'s post-issuance verification, and `summarizeCertbotFailure`'s
 * actionable DNS/firewall/proxy diagnosis instead of "check logs above".
 *
 * A hostname with no vhost is fine: `provisionCert` finds no route sidecar and no
 * conf to scrape, logs "cert provisioned but no route yet", and returns. It also
 * short-circuits on an already-valid cert, so retrying this step is cheap.
 *
 * Step 13 then symlinks the cert into Postfix/Dovecot's paths — reachable because
 * `/etc/letsencrypt` is a HOST bind mount into the edge, not a container volume.
 */
export async function stepRequestSSL(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
  target: MailSslTarget,
): Promise<StepResult> {
  const stepId = 7;
  const mailDomain = `mail.${domain}`;
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(mailDomain)) {
    return { stepId, success: false, message: `Invalid mail domain: ${mailDomain}` };
  }
  log(stepId, "info", `Requesting SSL certificate for ${mailDomain}...`);

  // Dynamic import to match webmail-project.service.ts — deployment-runtime pulls in
  // the platform/runtime graph, and the mail module is imported from it.
  const { resolveTargetPlatform } = await import("../../lib/deployment-runtime");

  try {
    const platform = await resolveTargetPlatform(
      "server",
      "bare",
      target.serverId,
      target.organizationId,
    );
    const result = await platform.ssl.provisionCert(mailDomain, {
      onLog: (line) => log(stepId, "info", line),
    });
    if (!result.verified) {
      return {
        stepId,
        success: false,
        message: `Certificate not confirmed for ${mailDomain} (${result.reason ?? "unknown"}).`,
      };
    }

    // Register the host so the ssl:renew sweep can see it. Without this the cert is
    // real, works, and then expires ~90 days later with nothing renewing it — the
    // renewer reads the `domain` table and a mail server has no project row.
    const { recordMailCertDomain } = await import("../../lib/domain-ssl");
    await recordMailCertDomain(mailDomain, result);

    log(stepId, "info", "SSL certificate obtained (the edge stayed up — apps unaffected)");
    return {
      stepId,
      success: true,
      message: `SSL certificate obtained for ${mailDomain}`,
      data: { expiresAt: result.expiresAt, issuer: result.issuer },
    };
  } catch (err) {
    // Already the summarized, actionable cause (summarizeCertbotFailure).
    return { stepId, success: false, message: errMsg(err) };
  }
}

/**
 * Step 8: Link Let's Encrypt certs into the paths Postfix/Dovecot expect, then
 * reload the mail daemons — a reload, no reboot.
 *
 * Runs where the daemons do: inside the engine on a containerized box, on the host
 * itself on a legacy one. A retry of this step against an adopted legacy server
 * used to `docker exec` into a container that isn't there, and every command here
 * ends in `|| true` — so it "succeeded" while linking nothing.
 */
export async function stepConfigureSSL(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const stepId = 8;
  const mailDomain = `mail.${domain}`;

  let flavor: MailEngineFlavor;
  try {
    ({ flavor } = await requireMailEngine(exec));
  } catch (err) {
    return { stepId, success: false, message: errMsg(err) };
  }

  // /etc/letsencrypt is the shared HOST bind mount the edge's certbot writes and
  // the mail container reads; loosen live/archive so the container can traverse.
  log(stepId, "info", "Setting Let's Encrypt directory permissions...");
  await exec.exec("chmod 0755 /etc/letsencrypt/live /etc/letsencrypt/archive 2>/dev/null || true");

  // The iRedMail cert symlinks live at /etc/ssl (baked into the image, not bind-
  // mounted) and point at the shared /etc/letsencrypt mount — so link + reload run
  // wherever the daemons read from.
  const inMail = (cmd: string) => mailEngineCommand(flavor, cmd);
  log(stepId, "info", "Backing up existing iRedMail self-signed certificates...");
  await exec.exec(inMail("mv /etc/ssl/certs/iRedMail.crt /etc/ssl/certs/iRedMail.crt.bak 2>/dev/null || true"));
  await exec.exec(inMail("mv /etc/ssl/private/iRedMail.key /etc/ssl/private/iRedMail.key.bak 2>/dev/null || true"));

  log(stepId, "info", "Linking Let's Encrypt certificates into mail daemon paths...");
  await exec.exec(inMail(`ln -sf /etc/letsencrypt/live/${mailDomain}/fullchain.pem /etc/ssl/certs/iRedMail.crt`));
  await exec.exec(inMail(`ln -sf /etc/letsencrypt/live/${mailDomain}/privkey.pem /etc/ssl/private/iRedMail.key`));

  log(stepId, "info", "Reloading mail daemons to pick up new certificates...");
  await exec.exec(inMail("postfix reload 2>/dev/null || true"));
  await exec.exec(inMail("doveadm reload 2>/dev/null || true"));

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

export type InstallerStepFn = (
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
  config?: IRedMailConfig,
) => Promise<StepResult>;

/**
 * Which server (and whose org) the cert is for. `stepRequestSSL` issues through
 * `platform.ssl`, and resolving that platform needs the server identity — an
 * executor alone can't say which row it belongs to.
 */
export interface MailSslTarget {
  serverId: string;
  organizationId: string;
}

export type SslStepFn = (
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
  target: MailSslTarget,
) => Promise<StepResult>;

export const STEP_RUNNERS: Record<
  number,
  BasicStepFn | InstallerStepFn | SslStepFn
> = {
  1: stepEnsureComponents,
  2: stepCheckPort25,
  3: stepEnsureReverseProxy,
  4: stepOpenMailFirewall,
  5: stepDeployEngine,
  6: stepDkimKeys,
  7: stepRequestSSL,
  8: stepConfigureSSL,
};


