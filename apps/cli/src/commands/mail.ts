/**
 * `openship mail` — self-hosted mail server (iRedMail) setup + admin.
 *
 * [self-host] only: every subcommand gates via caps.requireSelfHost. The
 * whole /api/mail mount is localOnly on the API side.
 *
 * Grounded in apps/api/src/modules/mail (routes in mail.routes.ts):
 *   Setup wizard
 *     steps        GET    /mail/steps
 *     status       GET    /mail/status?serverId=
 *     servers      GET    /mail/servers
 *     scan         POST   /mail/scan                 { serverId }
 *     adopt        POST   /mail/adopt                { serverId }
 *     setup        POST   /mail/setup   (SSE)        { serverId, domain, startStep?, config? }
 *     cancel       POST   /mail/setup/cancel
 *     dns-ack      POST   /mail/setup/dns-ack        { serverId }
 *     ptr-ack      POST   /mail/setup/ptr-ack        { serverId }
 *     reset        POST   /mail/setup/reset          { serverId }
 *     forget       DELETE /mail/servers/:serverId
 *   Post-install
 *     health       GET    /mail/health/:serverId
 *     logs         GET    /mail/admin/:serverId/components/:key/logs?lines=
 *     postmaster   POST   /mail/credentials/postmaster  { serverId, password }
 *   Admin panel   (/mail/admin/:serverId/…)
 *     domains      GET|POST|GET|PATCH|DELETE /admin/:id/domains[/:domain]
 *     mailboxes    GET|POST|GET|PATCH|DELETE /admin/:id/mailboxes[/:email]
 *     stats        GET    /admin/:id/stats
 *     test-email   POST   /admin/:id/test-email      { to, fromDomain? }
 *     dns-scan     GET    /admin/:id/dns-scan?domain=
 *   Webmail
 *     targets      GET    /mail/webmail/targets?serverId=
 *     deploy       POST   /mail/webmail/deploy-project  { mailServerId, hostname, target, internalPort? }
 *
 * Setup + webmail-deploy logs stream over lib/sse (sseRequest /
 * streamDeploymentLogs). The mail admin component-logs route is a JSON
 * snapshot (journal tail), not SSE — surfaced via `mail logs`.
 */
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { apiRequest, ApiError } from "../lib/api-client";
import { sseRequest } from "../lib/sse";
import { streamDeploymentLogs } from "../lib/deploy-stream";
import { getToken } from "../lib/config";
import { fetchCaps, requireSelfHost } from "../lib/caps";
import { isJsonMode, printJson, printTable, ok, err, info } from "../lib/output";

// ─── Shared plumbing ──────────────────────────────────────────────────────────

/**
 * Wrap a subcommand action: require a token, enforce self-host, and turn any
 * ApiError / network failure into a clean stderr message + exit(1).
 */
function guard<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    if (!getToken()) {
      err("Not logged in. Run `openship login` first.");
      process.exit(1);
    }
    try {
      requireSelfHost(await fetchCaps());
      await fn(...args);
    } catch (e) {
      err(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
      process.exit(1);
    }
  };
}

/** Spinner suppressed in JSON mode so stdout stays a clean data stream. */
function spin(text: string) {
  return isJsonMode() ? null : ora(text).start();
}

function safeParse(data: string): Record<string, unknown> {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return { raw: data };
  }
}

/** Render a mail DNS-records object ({ a, mx, spf, dkim, … }) as a table. */
function printRecordsObject(records: unknown): void {
  if (isJsonMode()) return printJson(records);
  const obj = (records ?? {}) as Record<string, { type?: string; name?: string; value?: string }>;
  const rows = Object.entries(obj).map(([k, r]) => ({
    key: k,
    type: r?.type ?? "",
    host: r?.name ?? "",
    value: r?.value ?? "",
  }));
  if (rows.length === 0) return info("  (no DNS records)");
  printTable(rows, ["key", "type", "host", "value"]);
}

// ─── Setup wizard ───────────────────────────────────────────────────────────

const stepsCmd = new Command("steps")
  .description("List the mail setup steps")
  .action(
    guard(async () => {
      const res = await apiRequest<{ steps: Array<{ id: number; key: string; label: string; description: string }>; total: number }>(
        "/mail/steps",
      );
      if (isJsonMode()) return printJson(res);
      printTable(
        res.steps.map((s) => ({ id: s.id, key: s.key, label: s.label, description: s.description })),
        ["id", "key", "label", "description"],
      );
      info(`  ${res.total} steps total.`);
    }),
  );

interface MailStatus {
  active: boolean;
  serverId?: string;
  domain?: string;
  currentStep?: number;
  dnsRecords?: unknown;
  dnsAcknowledged?: boolean;
  ptrAcknowledged?: boolean;
  errorMessage?: string;
  resumeStep?: number;
  steps?: Array<{ id: number; key: string; label: string; status?: string; message?: string }>;
  credentials?: Record<string, unknown>;
  webmail?: Record<string, unknown>;
}

const statusCmd = new Command("status")
  .description("Show the setup progress for a mail server")
  .argument("[serverId]", "Mail server ID (omit for the empty welcome shell)")
  .action(
    guard(async (serverId?: string) => {
      const q = serverId ? `?serverId=${encodeURIComponent(serverId)}` : "";
      const res = await apiRequest<MailStatus>(`/mail/status${q}`);
      if (isJsonMode()) return printJson(res);
      info(`  server:  ${res.serverId ?? "-"}`);
      info(`  domain:  ${res.domain ?? "-"}`);
      info(`  active:  ${res.active ? "yes (install running)" : "no"}`);
      if (res.currentStep) info(`  step:    ${res.currentStep}`);
      if (res.dnsAcknowledged !== undefined) info(`  dns ack: ${res.dnsAcknowledged ? "yes" : "no"}`);
      if (res.ptrAcknowledged !== undefined) info(`  ptr ack: ${res.ptrAcknowledged ? "yes" : "no"}`);
      if (res.errorMessage) err(`  error:   ${res.errorMessage}`);
      if (res.resumeStep) info(`  resume:  --start-step ${res.resumeStep}`);
      if (res.steps?.length) {
        printTable(
          res.steps.map((s) => ({ id: s.id, key: s.key, label: s.label, status: s.status ?? "pending", message: s.message ?? "" })),
          ["id", "key", "label", "status", "message"],
        );
      }
    }),
  );

const serversCmd = new Command("servers")
  .description("List every server the mail stack is installed on")
  .action(
    guard(async () => {
      const res = await apiRequest<{ servers: Array<{ id: string; name: string; host: string; port: number; user: string; domain: string; completed: boolean; active: boolean }> }>(
        "/mail/servers",
      );
      const rows = res.servers ?? [];
      if (isJsonMode()) return printJson(rows);
      if (rows.length === 0) return info("  No mail servers.");
      printTable(
        rows.map((s) => ({
          id: s.id,
          name: s.name,
          host: s.host,
          domain: s.domain,
          completed: s.completed ? "yes" : "no",
          active: s.active ? "yes" : "",
        })),
        ["id", "name", "host", "domain", "completed", "active"],
      );
    }),
  );

const scanCmd = new Command("scan")
  .description("Probe a server for an existing mail install (read-only)")
  .argument("<serverId>", "Server ID to scan")
  .action(
    guard(async (serverId: string) => {
      const sp = spin("Scanning server…");
      const res = await apiRequest<{
        serverId: string;
        iredmailInstalled: boolean;
        hasState: boolean;
        domain: string | null;
        installComplete: boolean;
        webmailPresent: boolean;
        adoptable: boolean;
      }>("/mail/scan", { method: "POST", body: JSON.stringify({ serverId }) });
      sp?.stop();
      if (isJsonMode()) return printJson(res);
      info(`  iRedMail live:  ${res.iredmailInstalled ? "yes" : "no"}`);
      info(`  state file:     ${res.hasState ? "yes" : "no"}`);
      info(`  domain:         ${res.domain ?? "-"}`);
      info(`  install done:   ${res.installComplete ? "yes" : "no"}`);
      info(`  webmail:        ${res.webmailPresent ? "yes" : "no"}`);
      if (res.adoptable) ok(`  Adoptable — run \`openship mail adopt ${serverId}\`.`);
      else info("  Nothing to adopt on this server.");
    }),
  );

const adoptCmd = new Command("adopt")
  .description("Re-adopt an existing mail install whose orchestrator state was lost")
  .argument("<serverId>", "Server ID to adopt")
  .action(
    guard(async (serverId: string) => {
      const sp = spin("Adopting mail server…");
      const res = await apiRequest<{ success: boolean; serverId: string; domain: string; completed: boolean }>(
        "/mail/adopt",
        { method: "POST", body: JSON.stringify({ serverId }) },
      );
      sp?.succeed(`Adopted ${res.domain}`);
      if (isJsonMode()) return printJson(res);
      info(`  domain:    ${res.domain}`);
      info(`  completed: ${res.completed ? "yes" : "no"}`);
    }),
  );

const setupCmd = new Command("setup")
  .description("Start or resume the mail setup wizard (streams over SSE)")
  .argument("<serverId>", "Server ID to install the mail stack on")
  .requiredOption("-d, --domain <domain>", "Mail domain (e.g. example.com)")
  .option("--start-step <n>", "Resume from a specific step (1-13)")
  .option("--config <json>", "iRedMail config overrides as a JSON object")
  .action(
    guard(async (serverId: string, opts) => {
      let config: unknown;
      if (opts.config) {
        try {
          config = JSON.parse(opts.config);
        } catch {
          err("  --config must be a valid JSON object.");
          process.exit(1);
        }
      }
      const body: Record<string, unknown> = { serverId, domain: opts.domain };
      if (opts.startStep) body.startStep = Number(opts.startStep);
      if (config) body.config = config;

      info(`  Setting up mail on ${serverId} for ${opts.domain}… (Ctrl-C to stop)`);
      let failed = false;
      for await (const ev of sseRequest("/mail/setup", {
        method: "POST",
        body: JSON.stringify(body),
      })) {
        if (ev.event === "ping") continue;
        const p = safeParse(ev.data);
        if (isJsonMode()) {
          printJson({ event: ev.event, ...p });
          if (ev.event === "error" || ev.event === "dns_pending" || ev.event === "ptr_pending") failed = ev.event === "error";
          continue;
        }
        switch (ev.event) {
          case "step_start":
            info(`  ▸ step ${p.stepId}: ${p.label}`);
            break;
          case "log": {
            const line = `    ${String(p.message ?? "")}`;
            process.stderr.write((p.level === "error" ? chalk.red(line) : chalk.dim(line)) + "\n");
            break;
          }
          case "step_done":
            if (p.success) ok(`  ✓ step ${p.stepId} done${p.warning ? ` (warning: ${p.warning})` : ""}`);
            else err(`  ✗ step ${p.stepId} failed: ${p.message ?? ""}`);
            break;
          case "dns_records":
            info("  DNS records to publish:");
            printRecordsObject(p.records);
            break;
          case "dns_pending":
            info("  Publish the DNS records above, then:");
            info(`    openship mail dns-ack ${serverId}`);
            info(`    openship mail setup ${serverId} --domain ${opts.domain} --start-step ${p.resumeStep}`);
            return;
          case "ptr_pending":
            info(`  Set reverse DNS (PTR) for ${p.ipv4}${p.ipv6 ? ` / ${p.ipv6}` : ""} → ${p.target}, then:`);
            info(`    openship mail ptr-ack ${serverId}`);
            info(`    openship mail setup ${serverId} --domain ${opts.domain} --start-step ${p.resumeStep}`);
            return;
          case "complete":
            ok(`  Mail setup complete for ${p.domain}.`);
            if (p.webmailUrl) info(`  Webmail: ${p.webmailUrl}`);
            if (p.adminUrl) info(`  Admin:   ${p.adminUrl}`);
            break;
          case "error":
            failed = true;
            err(`  ${p.message ?? "setup error"}`);
            if (p.resumeStep) info(`  Resume with --start-step ${p.resumeStep} after fixing.`);
            break;
        }
      }
      if (failed) process.exit(1);
    }),
  );

const cancelCmd = new Command("cancel")
  .description("Cancel the mail setup currently running")
  .action(
    guard(async () => {
      const res = await apiRequest<{ ok: boolean; message?: string }>("/mail/setup/cancel", {
        method: "POST",
      });
      if (isJsonMode()) return printJson(res);
      ok(`  ${res.message ?? "Cancellation requested"}`);
    }),
  );

/** Build the simple `{ serverId }`-body ack/reset commands from one factory. */
function ackCommand(name: string, path: string, description: string, successMsg: string): Command {
  return new Command(name)
    .description(description)
    .argument("<serverId>", "Mail server ID")
    .action(
      guard(async (serverId: string) => {
        const res = await apiRequest<{ ok: boolean }>(path, {
          method: "POST",
          body: JSON.stringify({ serverId }),
        });
        if (isJsonMode()) return printJson(res);
        ok(`  ${successMsg}`);
      }),
    );
}

const dnsAckCmd = ackCommand(
  "dns-ack",
  "/mail/setup/dns-ack",
  "Acknowledge that DNS records are published (releases the DKIM gate)",
  "DNS acknowledged. Re-run `mail setup` with --start-step to continue.",
);

const ptrAckCmd = ackCommand(
  "ptr-ack",
  "/mail/setup/ptr-ack",
  "Acknowledge that reverse DNS (PTR) is configured",
  "PTR acknowledged. Re-run `mail setup` with --start-step to continue.",
);

const resetCmd = new Command("reset")
  .description("Wipe the on-server setup state file (does NOT touch installed daemons)")
  .argument("<serverId>", "Mail server ID")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(
    guard(async (serverId: string, opts) => {
      if (!opts.yes && !isJsonMode()) {
        const rl = createInterface({ input, output });
        const answer = await rl.question(`  Wipe setup state for ${serverId}? [y/N] `);
        rl.close();
        if (answer.trim().toLowerCase() !== "y") return info("  Aborted.");
      }
      const res = await apiRequest<{ ok: boolean }>("/mail/setup/reset", {
        method: "POST",
        body: JSON.stringify({ serverId }),
      });
      if (isJsonMode()) return printJson(res);
      ok("  Setup state reset.");
    }),
  );

const forgetCmd = new Command("forget")
  .description("Stop managing a mail server (drops the DB row; leaves the stack + state intact)")
  .argument("<serverId>", "Mail server ID")
  .action(
    guard(async (serverId: string) => {
      const res = await apiRequest<{ ok: boolean }>(`/mail/servers/${encodeURIComponent(serverId)}`, {
        method: "DELETE",
      });
      if (isJsonMode()) return printJson(res);
      ok(`  Forgot mail server ${serverId} (re-adopt with \`mail scan\` + \`mail adopt\`).`);
    }),
  );

// ─── Post-install ─────────────────────────────────────────────────────────────

const healthCmd = new Command("health")
  .description("Show live status of every mail daemon")
  .argument("<serverId>", "Mail server ID")
  .action(
    guard(async (serverId: string) => {
      const sp = spin("Checking mail daemons…");
      const res = await apiRequest<{
        serverId: string;
        components: Array<{ key: string; label: string; status: string; subState?: string; unit: string }>;
      }>(`/mail/health/${encodeURIComponent(serverId)}`);
      sp?.stop();
      if (isJsonMode()) return printJson(res);
      printTable(
        res.components.map((c) => ({
          component: c.label,
          unit: c.unit,
          status: c.status,
          sub: c.subState ?? "",
        })),
        ["component", "unit", "status", "sub"],
      );
    }),
  );

const logsCmd = new Command("logs")
  .description("Tail a mail component's journal (snapshot)")
  .argument("<serverId>", "Mail server ID")
  .argument("<component>", "Component key (postfix|dovecot|amavis|clamav|iredapd|postgresql|…)")
  .option("-n, --lines <n>", "Number of lines (max 1000)", "200")
  .action(
    guard(async (serverId: string, component: string, opts) => {
      const res = await apiRequest<{ key: string; unit: string; lines: string[] }>(
        `/mail/admin/${encodeURIComponent(serverId)}/components/${encodeURIComponent(component)}/logs?lines=${encodeURIComponent(opts.lines)}`,
      );
      if (isJsonMode()) return printJson(res);
      info(`  ${res.unit}:`);
      for (const line of res.lines) process.stdout.write(line + "\n");
    }),
  );

const postmasterCmd = new Command("postmaster").description("Manage the postmaster mailbox");
postmasterCmd.addCommand(
  new Command("set-password")
    .description("Rotate the postmaster password")
    .argument("<serverId>", "Mail server ID")
    .option("--password <password>", "New password (min 12 chars); prompted if omitted")
    .action(
      guard(async (serverId: string, opts) => {
        let password: string | undefined = opts.password;
        if (!password) {
          if (isJsonMode()) {
            err("  --password is required in JSON mode.");
            process.exit(1);
          }
          const rl = createInterface({ input, output });
          password = (await rl.question("  New postmaster password (min 12 chars): ")).trim();
          rl.close();
        }
        if (!password || password.length < 12) {
          err("  Password must be at least 12 characters.");
          process.exit(1);
        }
        const sp = spin("Updating postmaster password…");
        const res = await apiRequest<{ ok: boolean }>("/mail/credentials/postmaster", {
          method: "POST",
          body: JSON.stringify({ serverId, password }),
        });
        sp?.succeed("Postmaster password updated.");
        if (isJsonMode()) printJson(res);
      }),
    ),
);

// ─── Parent ─────────────────────────────────────────────────────────────────

export const mailCommand = new Command("mail")
  .description("Self-hosted mail server (iRedMail) setup and admin [self-host]")
  .addCommand(stepsCmd)
  .addCommand(statusCmd)
  .addCommand(serversCmd)
  .addCommand(scanCmd)
  .addCommand(adoptCmd)
  .addCommand(setupCmd)
  .addCommand(cancelCmd)
  .addCommand(dnsAckCmd)
  .addCommand(ptrAckCmd)
  .addCommand(resetCmd)
  .addCommand(forgetCmd)
  .addCommand(healthCmd)
  .addCommand(logsCmd)
  .addCommand(postmasterCmd);
