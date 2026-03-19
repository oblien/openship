/**
 * Mail server setup service — orchestrates iRedMail installation on a
 * remote server via SSH, broken into discrete resumable steps.
 *
 * Each step is an isolated async function that runs commands through the
 * shared SSH executor. The controller streams progress to the frontend
 * via SSE so users see real-time status.
 *
 * CommandExecutor.exec() returns Promise<string> (stdout) and rejects
 * on non-zero exit. We wrap calls in try/catch for error handling.
 */

import type { CommandExecutor, LogEntry } from "@repo/adapters";
import {
  detectPortConflicts,
  wasTraefikMigrated,
  setupNginxGateway,
  type PortConflict,
} from "./port-manager";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

// ─── Step definitions ────────────────────────────────────────────────────────

export interface MailSetupStep {
  id: number;
  key: string;
  label: string;
  description: string;
}

export const MAIL_SETUP_STEPS: MailSetupStep[] = [
  { id: 1,  key: "system_update",       label: "System Update",              description: "Update and upgrade system packages" },
  { id: 2,  key: "check_port_25",       label: "Check Port 25",             description: "Verify outbound SMTP port is open" },
  { id: 3,  key: "check_web_ports",     label: "Check Web Ports",            description: "Check ports 80/443 and resolve conflicts" },
  { id: 4,  key: "set_hostname",        label: "Set Hostname",              description: "Configure server hostname to mail subdomain" },
  { id: 5,  key: "update_hosts",        label: "Update /etc/hosts",         description: "Add mail domain to hosts file" },
  { id: 6,  key: "download_iredmail",   label: "Download iRedMail",         description: "Download iRedMail 1.7.4 from GitHub" },
  { id: 7,  key: "extract_iredmail",    label: "Extract iRedMail",          description: "Extract the iRedMail archive" },
  { id: 8,  key: "run_installer",       label: "Run iRedMail Installer",    description: "Execute the iRedMail setup wizard" },
  { id: 9,  key: "first_reboot",        label: "Reboot Server",             description: "Reboot to activate mail services" },
  { id: 10, key: "reverse_proxy",       label: "Configure Reverse Proxy",   description: "Set up nginx gateway for Traefik integration" },
  { id: 11, key: "dkim_keys",           label: "Retrieve DKIM Keys",        description: "Get DKIM keys and DNS records" },
  { id: 12, key: "install_certbot",     label: "Install Certbot",           description: "Ensure certbot is available for SSL" },
  { id: 13, key: "request_ssl",         label: "Request SSL Certificate",   description: "Obtain Let's Encrypt SSL for mail domain" },
  { id: 14, key: "configure_ssl",       label: "Configure SSL",             description: "Link certificates and reboot" },
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
  /** Admin password for the mail server */
  adminPassword: string;
  /** Storage backend: mariadb | postgresql (default: mariadb) */
  storageBackend?: "mariadb" | "postgresql";
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

/** Step 2: Check outbound port 25 */
export async function stepCheckPort25(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  log(2, "info", "Testing outbound SMTP port 25...");
  // Use || to avoid rejection — always produces output
  const output = await exec.exec(
    "timeout 5 bash -c '</dev/tcp/portquiz.net/25' 2>&1 && echo PORT_OPEN || echo PORT_BLOCKED",
  );

  if (output.includes("PORT_OPEN")) {
    log(2, "info", "Port 25 is accessible");
    return { stepId: 2, success: true, message: "Port 25 is accessible" };
  }

  log(2, "warn", "Port 25 may be blocked — mail delivery could be affected");
  return {
    stepId: 2,
    success: true,
    message: "Port 25 may be blocked by ISP",
    warning: "Port 25 appears blocked. Mail delivery may be affected. You can continue, but some providers block outbound SMTP.",
  };
}

/**
 * Step 3: Check if ports 80/443 are free. If not, identify the service and
 * return conflict details so the frontend can offer resolution options.
 */
export async function stepCheckWebPorts(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const conflicts = await detectPortConflicts(exec, log, 3);

  if (conflicts.length === 0) {
    log(3, "info", "Ports 80 and 443 are free");
    return { stepId: 3, success: true, message: "Ports 80 and 443 are available" };
  }

  const summary = conflicts
    .map((c) => `port ${c.port}: ${c.serviceName ?? c.usage.process} (${c.type})`)
    .join(", ");

  return {
    stepId: 3,
    success: false,
    message: `Port conflict detected: ${summary}`,
    data: { portConflicts: conflicts as unknown as Record<string, unknown>[] },
  };
}

/** Step 4: Set hostname to mail.<domain> */
export async function stepSetHostname(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const mailDomain = `mail.${domain}`;
  log(4, "info", `Checking current hostname...`);

  const currentHostname = (await exec.exec("hostname -f")).trim();
  log(4, "info", `Current hostname: ${currentHostname}`);

  if (currentHostname === mailDomain) {
    log(4, "info", "Hostname already correct");
    return { stepId: 4, success: true, message: "Hostname already correct" };
  }

  log(4, "info", `Setting hostname to ${mailDomain}...`);
  try {
    await exec.exec(`hostnamectl set-hostname ${mailDomain}`);
  } catch (err) {
    return { stepId: 4, success: false, message: `Failed to set hostname: ${errMsg(err)}` };
  }

  log(4, "info", `Hostname set to ${mailDomain}`);
  return { stepId: 4, success: true, message: `Hostname set to ${mailDomain}` };
}

/** Step 5: Update /etc/hosts with 127.0.1.1 mail.<domain> */
export async function stepUpdateHosts(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const mailDomain = `mail.${domain}`;
  log(5, "info", "Checking /etc/hosts...");

  const countStr = await exec.exec("grep -c '^127.0.1.1' /etc/hosts || echo 0");
  const hasEntry = parseInt(countStr.trim(), 10) > 0;

  if (hasEntry) {
    const correctStr = await exec.exec(
      `grep -c '^127.0.1.1.*${mailDomain}' /etc/hosts || echo 0`,
    );
    if (parseInt(correctStr.trim(), 10) > 0) {
      log(5, "info", "/etc/hosts already configured correctly");
      return { stepId: 5, success: true, message: "/etc/hosts already configured" };
    }

    log(5, "info", "Updating existing 127.0.1.1 entry...");
    await exec.exec(
      `sed -i 's/^127.0.1.1.*/127.0.1.1 ${mailDomain} ${domain}/' /etc/hosts`,
    );
  } else {
    log(5, "info", "Adding 127.0.1.1 entry...");
    await exec.exec(
      `sed -i '/127.0.0.1/a 127.0.1.1 ${mailDomain} ${domain}' /etc/hosts`,
    );
  }

  const hosts = await exec.exec("cat /etc/hosts");
  log(5, "info", `Updated /etc/hosts:\n${hosts}`);
  return { stepId: 5, success: true, message: "/etc/hosts updated" };
}

/** Step 6: Download iRedMail 1.7.4 */
export async function stepDownloadIRedMail(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  log(6, "info", "Checking for existing iRedMail archive...");
  const exists = await exec.exec("[ -f /root/1.7.4.tar.gz ] && echo EXISTS || echo MISSING");

  if (exists.trim() === "EXISTS") {
    log(6, "info", "iRedMail archive already downloaded");
    return { stepId: 6, success: true, message: "iRedMail archive already present" };
  }

  log(6, "info", "Downloading iRedMail 1.7.4...");
  const dl = await streamCmd(
    exec,
    "wget -O /root/1.7.4.tar.gz https://github.com/iredmail/iRedMail/archive/refs/tags/1.7.4.tar.gz 2>&1",
    6, log,
  );
  if (dl.code !== 0) {
    return { stepId: 6, success: false, message: "Download failed" };
  }

  log(6, "info", "iRedMail 1.7.4 downloaded");
  return { stepId: 6, success: true, message: "iRedMail 1.7.4 downloaded" };
}

/** Step 7: Extract iRedMail archive */
export async function stepExtractIRedMail(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  log(7, "info", "Extracting iRedMail...");
  try {
    await exec.exec("cd /root && tar zxf 1.7.4.tar.gz");
  } catch (err) {
    return { stepId: 7, success: false, message: `Extract failed: ${errMsg(err)}` };
  }

  log(7, "info", "iRedMail extracted");
  return { stepId: 7, success: true, message: "iRedMail extracted to /root/iRedMail-1.7.4" };
}

/**
 * Step 8: Run iRedMail installer (non-interactive / auto-answer mode).
 *
 * We pre-seed iRedMail's config file so the installer runs unattended.
 */
export async function stepRunInstaller(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
  config?: IRedMailConfig,
): Promise<StepResult> {
  const adminPassword = config?.adminPassword ?? "ChangeMe123!";
  const backend = config?.storageBackend ?? "mariadb";

  log(8, "info", "Preparing iRedMail auto-config...");

  // Write auto-config to run non-interactively
  const configContent = [
    `export STORAGE_SERVER="127.0.0.1"`,
    `export STORAGE_BASE_DIR="/var/vmail"`,
    `export WEB_SERVER="NGINX"`,
    `export BACKEND_ORIG="${backend === "postgresql" ? "PGSQL" : "MYSQL"}"`,
    `export BACKEND="${backend === "postgresql" ? "PGSQL" : "MYSQL"}"`,
    `export VMAIL_DB_BIND_PASSWD="${adminPassword}"`,
    `export VMAIL_DB_ADMIN_PASSWD="${adminPassword}"`,
    `export FIRST_DOMAIN="${domain}"`,
    `export DOMAIN_ADMIN_PASSWD_PLAIN="${adminPassword}"`,
    `export USE_IREDADMIN="YES"`,
    `export USE_ROUNDCUBE="YES"`,
    `export USE_FAIL2BAN="YES"`,
    `export USE_NETDATA="NO"`,
  ].join("\n");

  await exec.writeFile("/root/iRedMail-1.7.4/config", configContent);

  log(8, "info", "Running iRedMail installer (this may take several minutes)...");
  const installer = await streamCmd(
    exec,
    "cd /root/iRedMail-1.7.4 && AUTO_USE_EXISTING_CONFIG_FILE=y AUTO_INSTALL_WITHOUT_CONFIRM=y AUTO_CLEANUP_REMOVE_SENDMAIL=y AUTO_CLEANUP_REMOVE_MOD_PYTHON=y bash iRedMail.sh 2>&1",
    8, log,
  );
  if (installer.code !== 0) {
    log(8, "error", "Installer exited with non-zero code");
    return {
      stepId: 8,
      success: false,
      message: "iRedMail installer failed. Check logs above.",
    };
  }

  log(8, "info", "iRedMail installer completed");
  return { stepId: 8, success: true, message: "iRedMail installed successfully" };
}

/** Step 9: Reboot server and wait for reconnection */
export async function stepReboot(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
  reconnectFn: () => Promise<CommandExecutor>,
): Promise<StepResult> {
  log(9, "info", "Rebooting server...");

  // Fire-and-forget reboot (will drop connection)
  exec.exec("sleep 2 && reboot").catch(() => {});

  log(9, "info", "Waiting 30 seconds for server to restart...");
  await sleep(30_000);

  log(9, "info", "Attempting to reconnect...");
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(9, "info", `Reconnection attempt ${attempt}/${maxAttempts}...`);
    try {
      const newExec = await reconnectFn();
      const out = await newExec.exec("echo connected");
      if (out.trim() === "connected") {
        log(9, "info", "Reconnected successfully");
        return { stepId: 9, success: true, message: "Server rebooted and reconnected" };
      }
    } catch {
      // Expected during reboot
    }
    await sleep(10_000);
  }

  return { stepId: 9, success: false, message: "Failed to reconnect after reboot" };
}

/**
 * Step 10: Configure reverse proxy — if Traefik was migrated during step 3,
 * set up nginx as a gateway so non-mail traffic continues to reach Traefik.
 * If Traefik was not involved, this step is a quick no-op.
 */
export async function stepConfigureReverseProxy(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const migrated = await wasTraefikMigrated(exec);
  if (!migrated) {
    log(10, "info", "No Traefik migration detected — skipping gateway setup");
    return { stepId: 10, success: true, message: "No reverse proxy configuration needed" };
  }

  const result = await setupNginxGateway(exec, `mail.${domain}`, log, 10);
  return {
    stepId: 10,
    success: result.success,
    message: result.message,
  };
}

/** Step 11: Retrieve DKIM keys and build DNS record instructions */
export async function stepDkimKeys(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const mailDomain = `mail.${domain}`;
  log(11, "info", "Checking for amavisd-new...");

  const whichOut = await exec.exec("command -v amavisd-new && echo FOUND || echo MISSING");
  if (whichOut.includes("MISSING")) {
    return {
      stepId: 11,
      success: false,
      message: "amavisd-new not found — iRedMail may not have installed correctly",
    };
  }

  log(11, "info", "Retrieving DKIM keys...");
  let rawOutput: string;
  try {
    rawOutput = await exec.exec("amavisd-new showkeys 2>&1");
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

  const dnsRecords = {
    dkim: {
      type: "TXT",
      name: `dkim._domainkey.${domain}`,
      value: dkimValue,
    },
    mx: {
      type: "MX",
      name: domain,
      priority: 10,
      value: mailDomain,
    },
    spf: {
      type: "TXT",
      name: domain,
      value: "v=spf1 mx ~all",
    },
    dmarc: {
      type: "TXT",
      name: `_dmarc.${domain}`,
      value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`,
    },
  };

  log(11, "info", "DKIM keys retrieved — DNS records ready");
  return {
    stepId: 11,
    success: true,
    message: "DKIM keys retrieved",
    data: { dnsRecords, rawOutput },
  };
}

/** Step 12: Install certbot if missing */
export async function stepInstallCertbot(
  exec: CommandExecutor,
  _domain: string,
  log: StepLogger,
): Promise<StepResult> {
  log(12, "info", "Checking for certbot...");
  const check = await exec.exec("command -v certbot && echo FOUND || echo MISSING");

  if (check.includes("FOUND")) {
    log(12, "info", "Certbot already installed");
    return { stepId: 12, success: true, message: "Certbot already installed" };
  }

  log(12, "info", "Installing certbot...");
  const inst = await streamCmd(
    exec,
    "DEBIAN_FRONTEND=noninteractive apt-get update -y && DEBIAN_FRONTEND=noninteractive apt-get install -y certbot 2>&1",
    12, log,
  );
  if (inst.code !== 0) {
    return { stepId: 12, success: false, message: "Failed to install certbot" };
  }

  log(12, "info", "Certbot installed");
  return { stepId: 12, success: true, message: "Certbot installed successfully" };
}

/** Step 13: Request SSL certificate for mail.<domain> */
export async function stepRequestSSL(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
): Promise<StepResult> {
  const mailDomain = `mail.${domain}`;
  log(13, "info", `Requesting SSL certificate for ${mailDomain}...`);

  // Stop web servers for standalone mode
  log(13, "info", "Stopping web server for standalone verification...");
  await exec.exec("systemctl stop nginx 2>/dev/null || true");
  await exec.exec("systemctl stop apache2 2>/dev/null || true");

  const cert = await streamCmd(
    exec,
    `certbot certonly --standalone --agree-tos --register-unsafely-without-email -d ${mailDomain} --non-interactive 2>&1`,
    13, log,
  );

  // Always restart web server
  await exec.exec("systemctl start nginx 2>/dev/null || systemctl start apache2 2>/dev/null || true");

  if (cert.code !== 0) {
    return {
      stepId: 13,
      success: false,
      message: "Failed to obtain SSL certificate. Check logs above.",
    };
  }

  log(13, "info", "SSL certificate obtained");
  return { stepId: 13, success: true, message: `SSL certificate obtained for ${mailDomain}` };
}

/** Step 14: Link Let's Encrypt certs → iRedMail paths + final reboot */
export async function stepConfigureSSL(
  exec: CommandExecutor,
  domain: string,
  log: StepLogger,
  reconnectFn: () => Promise<CommandExecutor>,
): Promise<StepResult> {
  const mailDomain = `mail.${domain}`;

  log(14, "info", "Setting Let's Encrypt directory permissions...");
  await exec.exec("chmod 0755 /etc/letsencrypt/live /etc/letsencrypt/archive");

  log(14, "info", "Backing up existing iRedMail certificates...");
  await exec.exec("mv /etc/ssl/certs/iRedMail.crt /etc/ssl/certs/iRedMail.crt.bak 2>/dev/null || true");
  await exec.exec("mv /etc/ssl/private/iRedMail.key /etc/ssl/private/iRedMail.key.bak 2>/dev/null || true");

  log(14, "info", "Linking Let's Encrypt certificates...");
  await exec.exec(
    `ln -sf /etc/letsencrypt/live/${mailDomain}/fullchain.pem /etc/ssl/certs/iRedMail.crt`,
  );
  await exec.exec(
    `ln -sf /etc/letsencrypt/live/${mailDomain}/privkey.pem /etc/ssl/private/iRedMail.key`,
  );

  log(14, "info", "SSL configured — rebooting to apply...");
  exec.exec("sleep 2 && reboot").catch(() => {});

  await sleep(30_000);

  log(14, "info", "Reconnecting after final reboot...");
  const maxAttempts = 12;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    log(14, "info", `Reconnection attempt ${attempt}/${maxAttempts}...`);
    try {
      const newExec = await reconnectFn();
      const out = await newExec.exec("echo connected");
      if (out.trim() === "connected") {
        log(14, "info", "Server is back online — mail setup complete!");
        return {
          stepId: 14,
          success: true,
          message: "SSL configured and server rebooted",
          data: {
            webmailUrl: `https://${mailDomain}/mail`,
            adminUrl: `https://${mailDomain}/iredadmin`,
          },
        };
      }
    } catch {
      // Expected during reboot
    }
    await sleep(10_000);
  }

  return { stepId: 14, success: false, message: "Server rebooted but failed to reconnect" };
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
  2: stepCheckPort25,
  3: stepCheckWebPorts,
  4: stepSetHostname,
  5: stepUpdateHosts,
  6: stepDownloadIRedMail,
  7: stepExtractIRedMail,
  8: stepRunInstaller,
  9: stepReboot,
  10: stepConfigureReverseProxy,
  11: stepDkimKeys,
  12: stepInstallCertbot,
  13: stepRequestSSL,
  14: stepConfigureSSL,
};


