/**
 * `openship doctor` — diagnose and repair a local Openship instance.
 *
 * For a LOCAL self-hosted box (the active context points at localhost) this is a
 * real health surface: service state, database liveness/migrations, deployed-
 * service containers, and system components — and, when the embedded database is
 * corrupt (the crash-loop-on-boot case), an interactive backup → heal → verify
 * repair. Interactive by default (a `@clack/prompts` panel + menu, like the bare
 * `openship` control panel); `--json` / non-TTY prints a machine-readable report
 * with a non-zero exit on failure; `--fix` runs the light repair with no prompts.
 *
 * For a REMOTE context it falls back to the original lightweight preflight
 * (config / context token / API reachable / runtime versions) — heal + local
 * service control only make sense on the machine the instance runs on.
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import open from "open";
import { intro, outro, note, select, log, spinner, confirm } from "@clack/prompts";
import { apiRaw } from "../lib/api-client";
import { CONFIG_PATH, getActiveContext, getApiUrl, getContext } from "../lib/config";
import { isJsonMode, printJson } from "../lib/output";
import { readInstanceUrl } from "../lib/ports";
import { stop as stopService, restart as restartService } from "../lib/service";
import { startService } from "./up";
import {
  gatherStatus,
  runRepair,
  ensure,
  dashboardPort,
  internalGet,
  waitApiHealthy,
  lastServiceError,
  type DoctorStatus,
  type CheckState,
} from "../lib/repair";
import {
  resolveDataDir,
  dataDirExists,
  backupDataDir,
  healDataDir,
} from "../lib/heal";

const GLYPH: Record<CheckState, string> = {
  pass: chalk.green("✓"),
  warn: chalk.yellow("!"),
  fail: chalk.red("✗"),
};

function isLocalContext(): boolean {
  return /localhost|127\.0\.0\.1|\[::1\]/i.test(getApiUrl());
}

/* ── DB / service check derivations ──────────────────────────────────────── */

function dbCheck(s: DoctorStatus): { state: CheckState; detail: string } {
  if (s.corrupted) return { state: "fail", detail: "corrupted — run a repair (see below)" };
  if (!s.apiUp) return { state: "warn", detail: "can't verify (API not answering)" };
  const db = s.health?.db;
  if (!db) return { state: "warn", detail: "no health report" };
  if (!db.ok) return { state: "fail", detail: db.driver + " not answering" };
  return {
    state: "pass",
    detail: `${db.driver} ok${db.latencyMs != null ? ` (${db.latencyMs}ms)` : ""}${
      db.migrationsApplied != null ? `, ${db.migrationsApplied} migrations` : ""
    }`,
  };
}

function serviceCheck(s: DoctorStatus): { state: CheckState; detail: string } {
  if (!s.service.installed) return { state: "warn", detail: "not installed as a service" };
  if (!s.service.running) return { state: "fail", detail: `installed but not running (${s.service.kind})` };
  return { state: "pass", detail: `running (${s.service.kind})` };
}

function servicesSummary(s: DoctorStatus): { state: CheckState; detail: string } {
  if (s.services.length === 0) {
    const n = s.health?.servicesConfigured;
    if (n && n > 0) return { state: "warn", detail: `${n} configured (no live container info)` };
    return { state: "pass", detail: "none deployed" };
  }
  const running = s.services.filter((x) => x.state === "running").length;
  const failed = s.services.filter((x) => x.state === "failed").length;
  const stopped = s.services.filter((x) => x.state === "stopped").length;
  return {
    state: failed > 0 ? "fail" : stopped > 0 ? "warn" : "pass",
    detail: `${running} running · ${stopped} stopped · ${failed} failed`,
  };
}

/* ── Panel (interactive) ─────────────────────────────────────────────────── */

function row(name: string, c: { state: CheckState; detail: string }): string {
  return `${GLYPH[c.state]} ${chalk.bold(name.padEnd(10))} ${chalk.dim(c.detail)}`;
}

function statusPanel(s: DoctorStatus): string {
  const lines = [
    row("Service", serviceCheck(s)),
    row("Database", dbCheck(s)),
    ...s.components.map((comp) => row(comp.name, { state: comp.state, detail: comp.detail })),
    row("Services", servicesSummary(s)),
  ];
  if (s.services.length > 0) {
    for (const svc of s.services.slice(0, 8)) {
      const g = svc.state === "running" ? GLYPH.pass : svc.state === "failed" ? GLYPH.fail : GLYPH.warn;
      lines.push(chalk.dim(`   ${g} ${svc.name} — ${svc.state}`));
    }
  }
  if (s.corrupted && s.lastError) lines.push("", chalk.red(`Last error: ${s.lastError}`));
  return lines.join("\n");
}

/* ── Remote fallback: original lightweight preflight ─────────────────────── */

function bunVersion(): string | null {
  const embedded = (process.versions as Record<string, string>).bun;
  if (embedded) return embedded;
  try {
    return execFileSync("bun", ["--version"], { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

async function remotePreflight(): Promise<void> {
  const checks: Array<{ name: string; status: CheckState; detail: string }> = [];
  const hasConfig = existsSync(CONFIG_PATH);
  checks.push({ name: "config", status: hasConfig ? "pass" : "warn", detail: hasConfig ? CONFIG_PATH : `not found; run \`openship login\`` });
  const context = getActiveContext();
  const apiUrl = getApiUrl();
  const hasToken = Boolean(getContext(context).token);
  checks.push({ name: "context", status: hasToken ? "pass" : "warn", detail: hasToken ? `${context} (${apiUrl})` : `${context} has no token; run \`openship login\`` });
  let reachable = false;
  try {
    const res = await apiRaw("/health", { signal: AbortSignal.timeout(6000) });
    reachable = res.ok;
    checks.push({ name: "api", status: res.ok ? "pass" : "fail", detail: res.ok ? `reachable (${apiUrl})` : `HTTP ${res.status} from ${apiUrl}` });
  } catch (e) {
    checks.push({ name: "api", status: "fail", detail: `unreachable: ${(e as Error).message}` });
  }
  checks.push({ name: "node", status: "pass", detail: process.versions.node });
  const bun = bunVersion();
  checks.push({ name: "bun", status: bun ? "pass" : "warn", detail: bun ?? "not installed (optional)" });

  if (isJsonMode()) {
    printJson({ context, apiUrl, reachable, checks });
  } else {
    process.stdout.write(chalk.bold("\n  Openship doctor\n\n"));
    for (const c of checks) process.stdout.write(`  ${GLYPH[c.status]} ${chalk.bold(c.name.padEnd(8))} ${c.detail}\n`);
    process.stdout.write("\n");
  }
  if (checks.some((c) => c.status === "fail")) process.exit(1);
}

/* ── One-shot report (--json / non-TTY, local) ───────────────────────────── */

async function reportOnce(): Promise<void> {
  const s = await gatherStatus();
  const svc = serviceCheck(s);
  const db = dbCheck(s);
  const services = servicesSummary(s);

  if (isJsonMode()) {
    printJson({
      dataDir: s.dataDir,
      service: s.service,
      apiUp: s.apiUp,
      db: s.health?.db ?? null,
      projects: s.health?.projects ?? null,
      services: { summary: services.detail, items: s.services },
      components: s.components,
      corrupted: s.corrupted,
      lastError: s.lastError,
    });
  } else {
    process.stdout.write(chalk.bold("\n  Openship doctor\n\n"));
    process.stdout.write(`  ${GLYPH[svc.state]} ${chalk.bold("Service".padEnd(10))} ${svc.detail}\n`);
    process.stdout.write(`  ${GLYPH[db.state]} ${chalk.bold("Database".padEnd(10))} ${db.detail}\n`);
    for (const c of s.components) process.stdout.write(`  ${GLYPH[c.state]} ${chalk.bold(c.name.padEnd(10))} ${c.detail}\n`);
    process.stdout.write(`  ${GLYPH[services.state]} ${chalk.bold("Services".padEnd(10))} ${services.detail}\n`);
    if (s.corrupted) process.stdout.write(chalk.yellow(`\n  Database looks corrupted — run \`openship doctor\` (interactive) or \`openship doctor --fix\`.\n`));
    process.stdout.write("\n");
  }
  const failed = svc.state === "fail" || db.state === "fail" || services.state === "fail" || s.components.some((c) => c.state === "fail");
  if (failed) process.exit(1);
}

/* ── Non-interactive light repair (--fix) ────────────────────────────────── */

async function autoFix(): Promise<void> {
  const out = (m: string) => process.stdout.write(`  ${m}\n`);
  if (!dataDirExists()) {
    out(chalk.dim(`No embedded database at ${resolveDataDir()} — nothing to repair.`));
    return;
  }
  if ((await internalGet("/api/system/health"))?.db?.ok) {
    out(chalk.green("Database is healthy — nothing to fix."));
    return;
  }
  out("Stopping the service…");
  stopService();
  await new Promise((r) => setTimeout(r, 2000));
  const backup = backupDataDir();
  out(`Backup saved → ${backup}`);
  const heal = healDataDir();
  out(`Repaired (${heal.removedPostmasterPid ? "cleared lock; " : ""}${heal.trimmedWalSegment ? `trimmed WAL ${heal.trimmedWalSegment}` : "no WAL tail"}).`);
  out("Restarting…");
  await startService({}, { quiet: true } as { quiet?: boolean });
  const healthy = await waitApiHealthy(60);
  const verified = healthy && !!(await internalGet("/api/system/health"))?.db?.ok;
  if (verified) {
    out(chalk.green("Database is healthy again. Your data is intact."));
  } else {
    out(chalk.red(`Still not healthy. Backup preserved at ${backup}. Run \`openship doctor\` for guided recovery.`));
    process.exit(1);
  }
}

/* ── Interactive doctor (TTY, local) ─────────────────────────────────────── */

async function interactiveDoctor(): Promise<void> {
  intro(`${chalk.bgCyan(chalk.black(" Openship "))}${chalk.dim(" doctor")}`);

  // Menu loop — re-gather status each pass so a repair/restart reflects live.
  for (;;) {
    const s = await gatherStatus();
    note(statusPanel(s), s.corrupted ? chalk.red("Database looks corrupted") : "Health");

    const options: Array<{ value: string; label: string; hint?: string }> = [];
    if (s.corrupted || (!s.apiUp && dataDirExists()) || (s.health?.db && !s.health.db.ok)) {
      options.push({ value: "repair", label: "Repair database", hint: "backup → heal → verify" });
    }
    options.push({ value: "recheck", label: "Re-run checks" });
    if (s.service.installed) options.push({ value: "restart", label: "Restart the service" });
    options.push({ value: "logs", label: "View recent errors" });
    options.push({ value: "open", label: "Open the dashboard" });
    options.push({ value: "quit", label: "Quit" });

    const action = ensure(
      await select({ message: "What would you like to do?", options, initialValue: options[0]?.value }),
    );

    if (action === "quit") {
      outro(chalk.dim("Bye."));
      return;
    }
    if (action === "recheck") continue;
    if (action === "repair") {
      const go = ensure(
        await confirm({ message: "Stop the service, back up the database, and repair it in place?", initialValue: true }),
      );
      if (!go) continue;
      const res = await runRepair();
      if (res.healed) log.success(res.detail);
      else log.warn(res.detail);
      continue;
    }
    if (action === "restart") {
      const sp = spinner();
      sp.start("Restarting");
      const r = restartService();
      const up = r.restarted ? await waitApiHealthy(45) : false;
      sp.stop(r.restarted && up ? chalk.green("Restarted and healthy.") : chalk.yellow(r.detail), r.restarted && up ? 0 : 1);
      continue;
    }
    if (action === "logs") {
      const err = lastServiceError();
      note(err ? chalk.red(err) : chalk.dim("No recent errors in the service logs."), "Recent errors");
      continue;
    }
    if (action === "open") {
      const url = readInstanceUrl();
      const target = url && !/^https?:\/\/localhost/i.test(url) ? url : `http://localhost:${dashboardPort()}`;
      await open(target).catch(() => {});
      log.message(chalk.dim(`Opening ${target}`));
      continue;
    }
  }
}

export const doctorCommand = new Command("doctor")
  .description("Check database + services health and repair a corrupt local database")
  .option("--fix", "Attempt an automatic database repair (backup → heal → restart), no prompts")
  .action(async (opts: { fix?: boolean }) => {
    // Remote instances: heal + local service control don't apply — keep the
    // original lightweight preflight.
    if (!isLocalContext()) {
      await remotePreflight();
      return;
    }
    if (opts.fix) {
      await autoFix();
      return;
    }
    // Non-interactive (piped / --json): one-shot report + exit code.
    if (isJsonMode() || !process.stdout.isTTY) {
      await reportOnce();
      return;
    }
    await interactiveDoctor();
  });
