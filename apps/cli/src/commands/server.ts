/**
 * `openship server` — manage self-hosted SSH servers.
 *
 * Grounded in the API's system module (mounted at /api/system, localOnly):
 *   list/add/rm       → GET|POST /system/servers, DELETE /system/servers/:id
 *   test-connection   → POST /system/test-connection   (ephemeral, no persist)
 *   check             → POST /system/check             (health vs saved server)
 *   install [--follow]→ POST /system/install | /system/install/stream (SSE)
 *   rate-limit        → GET|PATCH /system/servers/:id/rate-limit
 *   monitor           → GET  /system/monitor/stream    (SSE stats)
 *   ssh               → stubbed "coming soon" (interactive terminal needs ws)
 *
 * Every subcommand is [self-host] only: gated via caps.requireSelfHost.
 */
import { Command } from "commander";
import { createInterface } from "node:readline";
import chalk from "chalk";
import ora from "ora";
import { apiRequest, ApiError } from "../lib/api-client";
import { sseRequest } from "../lib/sse";
import { getToken } from "../lib/config";
import { fetchCaps, requireSelfHost } from "../lib/caps";
import { isJsonMode, printJson, printTable, ok, err, info } from "../lib/output";

const INSTALLABLE = ["docker", "git", "openresty", "certbot", "rsync"] as const;

/**
 * Wrap a subcommand action: require a token, enforce self-host, and turn any
 * ApiError / network failure into a clean stderr message + exit(1) rather than
 * an unhandled rejection stack trace. Commander's own args (operands, options,
 * command) pass straight through to `fn`.
 */
function guard<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
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

/** Interactive y/N confirm. Non-interactive (piped / CI) proceeds — the API's
 *  own active-deployment guard is the real safety net there. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise<string>((resolve) => rl.question(`${question} [y/N] `, resolve));
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

interface ServerRow {
  id: string;
  name: string | null;
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshAuthMethod: string | null;
  sshKeyPath: string | null;
  sshJumpHost: string | null;
  sshArgs: string | null;
  createdAt: string;
}

interface ConnOpts {
  host: string;
  name?: string;
  port: string;
  user: string;
  authMethod?: string;
  password?: string;
  keyPath?: string;
  keyPassphrase?: string;
  jumpHost?: string;
  sshArgs?: string;
}

/** Map CLI connection flags to the API's ssh* request body. */
function connBody(o: ConnOpts): Record<string, unknown> {
  return {
    name: o.name,
    sshHost: o.host,
    sshPort: Number(o.port),
    sshUser: o.user,
    sshAuthMethod: o.authMethod ?? null,
    sshPassword: o.password,
    sshKeyPath: o.keyPath,
    sshKeyPassphrase: o.keyPassphrase,
    sshJumpHost: o.jumpHost,
    sshArgs: o.sshArgs,
  };
}

const server = new Command("server").description("Manage self-hosted SSH servers");

/* ── list ───────────────────────────────────────────────────────── */
// GET /system/servers returns a bare array (no pagination envelope).
server
  .command("list")
  .alias("ls")
  .description("List servers in the active organization")
  .action(
    guard(async () => {
      const servers = await apiRequest<ServerRow[]>("/system/servers");
      if (isJsonMode()) return printJson(servers);
      if (servers.length === 0) return info("  No servers configured.");
      printTable(
        servers.map((s) => ({
          id: s.id,
          name: s.name ?? "-",
          host: s.sshHost,
          port: s.sshPort,
          user: s.sshUser,
          auth: s.sshAuthMethod ?? "-",
        })),
        ["id", "name", "host", "port", "user", "auth"],
      );
    }),
  );

/* ── add ────────────────────────────────────────────────────────── */
// POST /system/servers — sshHost is the only required field server-side.
server
  .command("add")
  .description("Add a new server")
  .requiredOption("--host <host>", "SSH host / IP")
  .option("--name <name>", "Display name")
  .option("--port <port>", "SSH port", "22")
  .option("--user <user>", "SSH user", "root")
  .option("--auth-method <method>", "Auth method (password|key|agent)")
  .option("--password <password>", "SSH password (password auth)")
  .option("--key-path <path>", "Path to private key (key auth)")
  .option("--key-passphrase <passphrase>", "Private key passphrase")
  .option("--jump-host <host>", "SSH jump / bastion host")
  .option("--ssh-args <args>", "Extra raw ssh args")
  .action(
    guard(async (o: ConnOpts) => {
      const created = await apiRequest<ServerRow>("/system/servers", {
        method: "POST",
        body: JSON.stringify(connBody(o)),
      });
      if (isJsonMode()) return printJson(created);
      ok(`  Added server ${created.name ?? created.sshHost} (${created.id})`);
    }),
  );

/* ── rm ─────────────────────────────────────────────────────────── */
server
  .command("rm <id>")
  .alias("remove")
  .description("Delete a server")
  .option("-f, --force", "Delete without confirmation, even if it has active deployments (orphans their containers)")
  .action(
    guard(async (id: string, opts: { force?: boolean }) => {
      if (!opts.force && !(await confirm(`Delete server ${id}? Any containers still running on it will be orphaned.`))) {
        info("Aborted.");
        return;
      }
      // force skips the API's active-deployment guard too (see deleteServer).
      const qs = opts.force ? "?force=true" : "";
      await apiRequest(`/system/servers/${encodeURIComponent(id)}${qs}`, { method: "DELETE" });
      if (isJsonMode()) return printJson({ ok: true, id });
      ok(`  Removed server ${id}`);
    }),
  );

/* ── test-connection ────────────────────────────────────────────── */
// POST /system/test-connection validates creds WITHOUT saving them.
server
  .command("test-connection")
  .alias("test")
  .description("Test an SSH connection without saving it")
  .requiredOption("--host <host>", "SSH host / IP")
  .option("--port <port>", "SSH port", "22")
  .option("--user <user>", "SSH user", "root")
  .option("--auth-method <method>", "Auth method (password|key|agent)")
  .option("--password <password>", "SSH password")
  .option("--key-path <path>", "Path to private key")
  .option("--key-passphrase <passphrase>", "Private key passphrase")
  .option("--jump-host <host>", "SSH jump / bastion host")
  .option("--ssh-args <args>", "Extra raw ssh args")
  .action(
    guard(async (o: ConnOpts) => {
      const spinner = isJsonMode() ? null : ora(`Connecting to ${o.host}…`).start();
      try {
        // The API returns { ok:false } on a reachable-but-failed handshake and
        // throws (via ApiError) on 4xx/5xx — surface both as a failed test.
        const res = await apiRequest<{ ok: boolean; message: string }>("/system/test-connection", {
          method: "POST",
          body: JSON.stringify(connBody(o)),
        });
        spinner?.stop();
        if (isJsonMode()) return printJson(res);
        if (res.ok) return ok(`  ${res.message}`);
        err(`  ${res.message}`);
        process.exit(1);
      } catch (e) {
        spinner?.stop();
        throw e;
      }
    }),
  );

/* ── check ──────────────────────────────────────────────────────── */
// POST /system/check runs health checks against a SAVED server (by id).
server
  .command("check <serverId>")
  .description("Run component health checks against a saved server")
  .option("-c, --component <name...>", "Limit to specific components")
  .action(
    guard(async (serverId: string, o: { component?: string[] }) => {
      const spinner = isJsonMode() ? null : ora("Checking components…").start();
      const res = await apiRequest<{
        components: Array<{ name: string; installed?: boolean; healthy?: boolean; version?: string; optional?: boolean }>;
        ready: boolean;
        missing: string[];
      }>("/system/check", {
        method: "POST",
        body: JSON.stringify({ serverId, components: o.component }),
      });
      spinner?.stop();
      if (isJsonMode()) return printJson(res);
      printTable(
        res.components.map((c) => ({
          component: c.name,
          installed: c.installed ? "yes" : "no",
          healthy: c.healthy ? "yes" : "no",
          version: c.version ?? "-",
          optional: c.optional ? "yes" : "no",
        })),
        ["component", "installed", "healthy", "version", "optional"],
      );
      if (res.ready) ok("  Server is ready.");
      else err(`  Missing required components: ${res.missing.join(", ") || "none"}`);
    }),
  );

/* ── update (native-module migrations) ──────────────────────────── */
// --check: report drift only. Default: apply pending migrations (incl. consent).
interface ModuleRow {
  moduleName: string;
  installedVersion: string | null;
  migrationVersion: string | null;
  availableVersion: string | null;
  behind: boolean;
  detail: { pendingConsent?: { id: string; version: string; warning?: string }[] } | null;
}
interface ModuleApplyResult {
  module: string; fromVersion: string; toVersion: string;
  appliedSteps: string[]; ok: boolean; error?: string;
}
server
  .command("update <serverId>")
  .description("Check for and apply native-module migrations (OpenResty, …)")
  .option("-c, --component <name...>", "Limit to specific modules")
  .option("--check", "Only report drift; don't apply")
  .action(
    guard(async (serverId: string, o: { component?: string[]; check?: boolean }) => {
      const base = `/system/servers/${encodeURIComponent(serverId)}/modules`;
      // Refresh the drift cache from the live box first (best-effort).
      await apiRequest(`${base}/scan`, { method: "POST", body: "{}" }).catch(() => {});
      let mods = await apiRequest<ModuleRow[]>(base);
      if (o.component?.length) mods = mods.filter((m) => o.component!.includes(m.moduleName));

      if (o.check) {
        if (isJsonMode()) return printJson(mods);
        printTable(
          mods.map((m) => ({
            module: m.moduleName,
            installed: m.installedVersion ?? "-",
            current: m.migrationVersion ?? "-",
            available: m.availableVersion ?? "-",
            behind: m.behind ? "yes" : "no",
            consent: String(m.detail?.pendingConsent?.length ?? 0),
          })),
          ["module", "installed", "current", "available", "behind", "consent"],
        );
        return;
      }

      const behind = mods.filter((m) => m.behind);
      if (!behind.length) return ok("  All modules up to date.");
      for (const m of behind) {
        const consent = m.detail?.pendingConsent ?? [];
        if (consent.length && !isJsonMode()) {
          info(`  ${m.moduleName}: includes consent migrations — ${consent.map((c) => c.warning ?? c.id).join("; ")}`);
        }
        const spinner = isJsonMode() ? null : ora(`Updating ${m.moduleName}…`).start();
        const res = await apiRequest<ModuleApplyResult>(`${base}/${encodeURIComponent(m.moduleName)}/apply`, {
          method: "POST",
          body: "{}",
        });
        spinner?.stop();
        if (isJsonMode()) { printJson(res); continue; }
        if (res.ok) ok(`  ${m.moduleName}: ${res.fromVersion} → ${res.toVersion} (${res.appliedSteps.length} step(s))`);
        else err(`  ${m.moduleName}: ${res.error ?? "update failed"}`);
      }
    }),
  );

/* ── install ────────────────────────────────────────────────────── */
// Without --follow: POST /system/install once per component (JSON result).
// With --follow:    POST /system/install/stream and render the SSE log feed.
server
  .command("install <serverId>")
  .description("Install components on a server")
  .requiredOption("-c, --component <name...>", `Components to install (${INSTALLABLE.join("|")})`)
  .option("--follow", "Stream install logs live (SSE)")
  .action(
    guard(async (serverId: string, o: { component: string[]; follow?: boolean }) => {
      const components = o.component;
      const invalid = components.filter((c) => !INSTALLABLE.includes(c as (typeof INSTALLABLE)[number]));
      if (invalid.length) {
        err(`  Unknown component(s): ${invalid.join(", ")}. Valid: ${INSTALLABLE.join(", ")}`);
        process.exit(1);
      }

      if (o.follow) {
        info(`  Installing ${components.join(", ")} on ${serverId}… (Ctrl-C to stop)`);
        let failed = false;
        for await (const ev of sseRequest("/system/install/stream", {
          method: "POST",
          body: JSON.stringify({ serverId, components }),
        })) {
          if (ev.event === "ping") continue;
          const payload = safeParse(ev.data);
          if (isJsonMode()) {
            printJson({ event: ev.event, ...payload });
          } else if (ev.event === "log") {
            const p = payload as { component?: string; message?: string; level?: string };
            const line = `  ${chalk.dim(`[${p.component}]`)} ${p.message ?? ""}`;
            process.stderr.write((p.level === "error" ? chalk.red(line) : line) + "\n");
          } else if (ev.event === "progress") {
            const p = payload as { component?: string | null; status?: string };
            if (p.component) info(`  ${p.component}: ${p.status}`);
          } else if (ev.event === "complete") {
            failed = (payload as { status?: string }).status !== "completed";
          } else if (ev.event === "error") {
            failed = true;
            err(`  ${(payload as { error?: string }).error ?? "install error"}`);
          } else if (ev.event === "end") {
            break;
          }
        }
        if (failed) process.exit(1);
        return ok("  Install finished.");
      }

      // Non-streaming: install each component sequentially.
      const results: unknown[] = [];
      let anyFailed = false;
      for (const component of components) {
        const spinner = isJsonMode() ? null : ora(`Installing ${component}…`).start();
        const res = await apiRequest<{ success: boolean; component: string; version?: string; error?: string }>(
          "/system/install",
          { method: "POST", body: JSON.stringify({ serverId, component }) },
        );
        results.push(res);
        if (!res.success) anyFailed = true;
        if (isJsonMode()) spinner?.stop();
        else if (res.success) spinner?.succeed(`${component} installed${res.version ? ` (${res.version})` : ""}`);
        else spinner?.fail(`${component} failed: ${res.error ?? "unknown error"}`);
      }
      if (isJsonMode()) printJson(results);
      // Match the streaming path: a failed component must fail the command so CI
      // and scripts don't read a partial install as success.
      if (anyFailed) process.exit(1);
    }),
  );

/* ── rate-limit ─────────────────────────────────────────────────── */
// GET reads the live OpenResty config; any of --rps/--burst/--whitelist PATCHes.
server
  .command("rate-limit <serverId>")
  .description("Read or update per-server OpenResty rate limiting")
  .option("--rps <n>", "Requests per second (0 removes the limit)")
  .option("--burst <n>", "Burst allowance")
  .option("--whitelist <cidr...>", "CIDRs exempt from limiting")
  .action(
    guard(async (serverId: string, o: { rps?: string; burst?: string; whitelist?: string[] }) => {
      const path = `/system/servers/${encodeURIComponent(serverId)}/rate-limit`;
      const mutate = o.rps !== undefined || o.burst !== undefined || o.whitelist !== undefined;

      if (mutate) {
        const res = await apiRequest<{ success: boolean; config: unknown; error?: string }>(path, {
          method: "PATCH",
          body: JSON.stringify({
            rps: o.rps !== undefined ? Number(o.rps) : undefined,
            burst: o.burst !== undefined ? Number(o.burst) : undefined,
            whitelist: o.whitelist,
          }),
        });
        if (isJsonMode()) return printJson(res);
        if (!res.success) return err(`  ${res.error ?? "Update failed"}`);
        printRateLimit(res.config);
        return ok("  Rate limit updated.");
      }

      const res = await apiRequest<{ config: unknown }>(path);
      if (isJsonMode()) return printJson(res);
      printRateLimit(res.config);
    }),
  );

/* ── monitor ────────────────────────────────────────────────────── */
// GET /system/monitor/stream?serverId= — SSE emitting "stats" every ~3s.
server
  .command("monitor <serverId>")
  .description("Stream live system stats (SSE)")
  .action(
    guard(async (serverId: string) => {
      info(`  Streaming stats for ${serverId}… (Ctrl-C to stop)`);
      for await (const ev of sseRequest(`/system/monitor/stream?serverId=${encodeURIComponent(serverId)}`)) {
        if (ev.event === "ping") continue;
        const payload = safeParse(ev.data);
        if (isJsonMode()) {
          printJson({ event: ev.event, ...payload });
          continue;
        }
        if (ev.event === "error") {
          err(`  ${(payload as { error?: string }).error ?? "monitor error"}`);
          continue;
        }
        const s = payload as {
          cpu?: number; memTotal?: number; memUsed?: number;
          diskTotal?: number; diskUsed?: number; uptime?: string;
          load1?: string; load5?: string; load15?: string;
        };
        const mem = s.memTotal ? `${fmtBytes(s.memUsed ?? 0)}/${fmtBytes(s.memTotal)}` : "-";
        const disk = s.diskTotal ? `${fmtBytes(s.diskUsed ?? 0)}/${fmtBytes(s.diskTotal)}` : "-";
        process.stdout.write(
          `  cpu ${String(s.cpu ?? "-").padStart(3)}%  mem ${mem}  disk ${disk}  ` +
            `load ${s.load1 ?? "-"} ${s.load5 ?? "-"} ${s.load15 ?? "-"}  up ${fmtUptime(s.uptime)}\n`,
        );
      }
    }),
  );

/* ── ssh (stub) ─────────────────────────────────────────────────── */
// Interactive terminal needs a WebSocket client (ws dep) — deliberately out of
// scope; the API side is a WS terminal, not SSE. Stubbed for now.
server
  .command("ssh <serverId>")
  .description("Open an interactive SSH terminal (coming soon)")
  .action(() => {
    info("  `openship server ssh` is coming soon.");
    info("  Interactive terminals require a WebSocket client that isn't bundled yet.");
    process.exit(1);
  });

// ── helpers ──────────────────────────────────────────────────────
function safeParse(data: string): Record<string, unknown> {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return { raw: data };
  }
}

function printRateLimit(config: unknown): void {
  const c = config as { rps?: number; burst?: number; whitelist?: string[] };
  printTable(
    [{ rps: c.rps ?? 0, burst: c.burst ?? 0, whitelist: (c.whitelist ?? []).join(", ") || "-" }],
    ["rps", "burst", "whitelist"],
  );
}

function fmtBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)}${units[i]}`;
}

function fmtUptime(seconds?: string): string {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return "-";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d${h}h` : h > 0 ? `${h}h${m}m` : `${m}m`;
}

export const serverCommand = server;
