/**
 * `openship edge` — install-and-manage the OpenResty edge (reverse proxy) that
 * fronts this box on :80/:443, and drive its per-route features.
 *
 * This command groups operations that ALREADY exist elsewhere in the CLI/API —
 * nothing here is a new pipeline:
 *
 *   Host-side (Linux-only, no login needed — talks to the local docker/host):
 *     status              → diagnoseEdge()                     (lib/edge-preflight)
 *     up | install        → diagnoseEdge() + repairEdgeConflict (ensure/repair only)
 *     migrate             → repairEdgeConflict("migrate", …)    (import a foreign proxy's sites)
 *     takeover            → repairEdgeConflict("stop", …)       (free :80/:443, sites drop)
 *     repair | doctor     → diagnoseEdge() + repairEdgeConflict
 *     sites | scan        → detectInstalledProxy + scanImportableSites (@repo/adapters/proxy)
 *
 *   Control-plane (authenticated — reuses the running API via the active context):
 *     rules   list|add|rm    → /api/projects/:id/route-rules    (route-rule.controller)
 *     domains list|add|rm    → /api/domains (+ /api/projects for --port)  (see `openship domain`)
 *     traffic                → /api/analytics/overview           (requests + bandwidth)
 *     analytics              → /api/analytics/geo                (visitors, countries, paths)
 *     logs                   → /api/projects/:id/server-logs/recent
 *
 *   Install (host-side): `up`/`install` ensures the edge is serving and, with
 *     --monitoring, provisions the bundled API on embedded PGlite (the same
 *     `openship up --bare` pipeline) so analytics have a place to land. Detect-first:
 *     an existing Openship install is reused untouched.
 *
 * The edge itself is a CONTAINER the compose stack owns (`openship up` brings it
 * up on :80/:443). This command deliberately does NOT reimplement that install —
 * the containerized API is what registers sites into the edge (it holds the docker
 * socket + the shared routing volumes), which is exactly why migrate/takeover here
 * delegate through the API's import endpoint rather than writing vhosts by hand.
 */

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Command } from "commander";
import chalk from "chalk";
import { intro, outro, select, isCancel, note, text, password, confirm, log } from "@clack/prompts";

import { getRemoteClient, ApiError } from "../lib/ship-client";
import { iteratePages } from "@repo/sdk/client";
import { CreateDomainInputSchema, parseInput, isRecord, type Domain, type DomainRecords, type RouteRule } from "@repo/contracts";
import { attachCustomDomainEndpoint } from "../lib/custom-domain-endpoint";
import { positiveInteger } from "../lib/command-input";
import { printEvents } from "../lib/event-output";
import { spin, fail } from "../lib/cmd-helpers";
import { getApiUrl } from "../lib/config";
import { printJson, printTable, isJsonMode, ok, err, info } from "../lib/output";
import { storedApiPort } from "../lib/ports";
import { serviceStatus } from "../lib/service";
import { readInstallMethod } from "../lib/compose";
import { diagnoseEdge, type EdgeDiagnosis } from "../lib/edge-preflight";
import {
  LocalExecutor,
  detectInstalledProxy,
  scanImportableSites,
  type ImportedSite,
} from "@repo/adapters/proxy";

// repairEdgeConflict lives in lib/edge-preflight but is imported lazily inside the
// actions that need it: it dynamically pulls in ./edge-import (the API import path),
// so keeping it off the module's static graph keeps `openship edge status` cheap.
type RepairMode = "migrate" | "stop";
type LogLevel = "info" | "warn" | "error";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);

/** The containerized edge (and :80/:443 contention) is a Linux-only concept. */
function requireLinux(): void {
  if (process.platform === "linux") return;
  err("  The Openship edge runs as a Linux container — this command only works on the host that runs it.");
  process.exit(1);
}

/** Compose API port this install is configured with — where the import endpoint lives. */
function apiPort(): string {
  return String(storedApiPort());
}

/** Progress sink for the repair path; dim/yellow/red by level, off in JSON mode. */
function onLog(message: string, level: LogLevel = "info"): void {
  if (isJsonMode()) return;
  const paint = level === "error" ? chalk.red : level === "warn" ? chalk.yellow : chalk.dim;
  process.stderr.write(paint(`  ${message}`) + "\n");
}

/** One-line human summary of an edge diagnosis. */
function describeDiagnosis(d: EdgeDiagnosis): string {
  if (d.healthy) return chalk.green("serving on :80/:443");
  if (!d.containerExists) return chalk.yellow("not installed");
  if (d.hostProxySquatting) return chalk.red(`blocked — a host proxy holds the ports${d.occupant ? ` (${d.occupant})` : ""}`);
  if (d.occupant) return chalk.red(`blocked by ${d.occupant}`);
  if (!d.containerRunning) return chalk.red("container not running");
  return chalk.yellow("not serving");
}

/** Print a diagnosis (JSON verbatim, else a compact status block). */
function printDiagnosis(d: EdgeDiagnosis): void {
  if (isJsonMode()) {
    printJson(d);
    return;
  }
  info(`  Edge:       ${describeDiagnosis(d)}`);
  info(`  Container:  ${d.containerExists ? (d.containerRunning ? "running" : "present, stopped") : "absent"}`);
  if (d.occupant) info(`  Occupant:   ${d.occupant}`);
  if (d.sites.length) info(`  Importable: ${d.sites.length} site(s) on the occupant`);
}

/** Render parsed sites as a table (shared by `sites` and the migrate preview). */
function printSites(sites: ImportedSite[]): void {
  if (isJsonMode()) {
    printJson(sites);
    return;
  }
  if (sites.length === 0) {
    info("  No importable sites found.");
    return;
  }
  printTable(
    sites.map((s) => ({
      host: (s.serverNames ?? []).join(", ") || "(no server_name)",
      target: s.target.kind === "static" ? `static:${s.target.root}` : s.target.url,
      tls: s.ssl ? "yes" : "",
    })),
    ["host", "target", "tls"],
  );
}

type RepairResult = { ok: boolean; registered: string[]; detail: string };

/** Render a repairEdgeConflict outcome (never exits) — shared by the verb and the panel. */
function renderRepair(res: RepairResult): void {
  if (isJsonMode()) {
    printJson(res);
    return;
  }
  if (res.ok) ok(`  ✓ ${res.detail}`);
  else err(`  ✗ ${res.detail}`);
  if (res.registered.length) info(`  Registered: ${res.registered.join(", ")}`);
}

/** Print a repairEdgeConflict outcome and exit with its status. */
function reportRepair(res: RepairResult): never {
  renderRepair(res);
  process.exit(res.ok ? 0 : 1);
}

/** Grouped integer, e.g. 12,345. */
function fmtInt(n?: number | null): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString("en-US") : "0";
}

/** Human bandwidth, e.g. 1.4 MB. */
function fmtBytes(n?: number | null): string {
  const b = Number(n ?? 0);
  if (!Number.isFinite(b) || b <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

// ─── Host-side actions ───────────────────────────────────────────────────────

/** Free :80/:443 and (re)start the edge in a chosen mode, via the shared repair path. */
async function runRepair(mode: RepairMode): Promise<never> {
  requireLinux();
  const sp = spin(mode === "migrate" ? "Migrating the existing proxy's sites into the edge…" : "Taking over :80/:443…");
  try {
    const { repairEdgeConflict } = await import("../lib/edge-preflight");
    sp?.stop();
    const res = await repairEdgeConflict(mode, apiPort(), onLog);
    reportRepair(res);
  } catch (e) {
    observeCaughtError(e, "cli/commands/edge");
    sp?.fail("Edge repair failed");
    fail(e);
  }
}

/**
 * `up`/`repair`: ensure the edge is serving. Healthy → say so. Not installed →
 * point at `openship up` (we don't duplicate the stack installer). Otherwise pick
 * an action (flag, prompt, or sensible default) and run the shared repair path.
 */
async function runUp(opts: { migrate?: boolean; takeover?: boolean }): Promise<never> {
  requireLinux();
  const sp = spin("Checking the edge…");
  const diag = await diagnoseEdge();
  sp?.stop();

  if (diag.healthy) {
    ok("  ✓ Edge is up and serving on :80/:443.");
    if (isJsonMode()) printJson(diag);
    process.exit(0);
  }

  if (!diag.containerExists) {
    printDiagnosis(diag);
    err("\n  No Openship edge container on this box.");
    info("  Install the stack first — `openship up` brings up the edge (OpenResty on :80/:443).");
    process.exit(1);
  }

  // Container exists but isn't serving — usually a foreign proxy on the ports, or
  // a stopped edge. Choose how to make the ports ours.
  printDiagnosis(diag);
  let mode: RepairMode;
  if (opts.migrate) mode = "migrate";
  else if (opts.takeover) mode = "stop";
  else if (diag.sites.length > 0 && interactive && !isJsonMode()) {
    const choice = await select({
      message: `An existing proxy holds :80/:443 with ${diag.sites.length} site(s).`,
      options: [
        { value: "migrate", label: `Migrate ${diag.sites.length} site(s) & take over`, hint: "keep them serving" },
        { value: "stop", label: "Stop it & take over", hint: "its sites stop being served" },
        { value: "cancel", label: "Cancel" },
      ],
      initialValue: "migrate",
    });
    if (isCancel(choice) || choice === "cancel") {
      info("  Left the existing proxy running.");
      process.exit(0);
    }
    mode = choice as RepairMode;
  } else {
    // No flag, no prompt: migrate when there are sites to save, else just free the ports.
    mode = diag.sites.length > 0 ? "migrate" : "stop";
  }
  return runRepair(mode);
}

/** `sites`/`scan`: enumerate what an installed (possibly stopped) proxy would migrate. */
async function scanSites(): Promise<void> {
  requireLinux();
  const sp = spin("Scanning for importable sites…");
  try {
    const executor = new LocalExecutor();
    const proxy = await detectInstalledProxy(executor);
    if (!proxy) {
      sp?.stop();
      info("  No importable reverse proxy found on this host.");
      if (isJsonMode()) printJson([]);
      return;
    }
    const { sites } = await scanImportableSites(executor, proxy);
    sp?.stop();
    if (!isJsonMode()) info(`  Found ${proxy} with ${sites.length} site(s):`);
    printSites(sites);
    if (sites.length > 0 && !isJsonMode()) {
      info("\n  Import them with `openship edge migrate` (takes over :80/:443, keeps them serving).");
    }
  } catch (e) {
    observeCaughtError(e, "cli/commands/edge");
    sp?.fail("Scan failed");
    fail(e);
  }
}

/** `status`/`repair`/`doctor`: diagnose only (repair is opt-in via `--fix`). */
async function runStatus(opts: { fix?: boolean; migrate?: boolean; takeover?: boolean }): Promise<never> {
  requireLinux();
  const sp = spin("Diagnosing the edge…");
  const diag = await diagnoseEdge();
  sp?.stop();
  printDiagnosis(diag);
  if (diag.healthy || !opts.fix) process.exit(diag.healthy ? 0 : 1);
  // --fix: fall through to the same ensure/repair path.
  return runUp({ migrate: opts.migrate, takeover: opts.takeover });
}

// ─── Interactive panel (bare `openship edge`) ────────────────────────────────
//
// A persistent, flat, domain-centric loop (like `openship doctor`): the edge routes
// domains → ports and doesn't care about projects, so the panel's primary axis is a
// flat list of the domains it serves. `projectId` is resolved and carried under the
// hood only where an endpoint still needs it (route-rules, domain removal). Every
// action returns to the menu — errors render, they don't exit — so only Quit leaves.
// Analytics use the SERVER-scoped routes (/analytics/server/:serverId?domain=), which
// are project-free; the scriptable `traffic`/`analytics` verbs stay project-scoped.

const IS_LINUX = process.platform === "linux";

/** Cached id of the local ("This Server") row — analytics are keyed on it. */
let localServerId: string | null = null;

/** A domain the edge serves, flattened out of its owning project. */
interface DomainEntry {
  id: string;
  hostname: string;
  port: number | null;
  projectId: string;
  verified: boolean;
  sslStatus: string | null;
  status: string | null;
}

/** Prompt for a required non-empty string; returns null on cancel/blank. */
async function promptRequired(message: string, placeholder?: string): Promise<string | null> {
  const v = await text({ message, placeholder });
  if (isCancel(v)) return null;
  const s = String(v ?? "").trim();
  return s || null;
}

/** Render an error inside the panel WITHOUT exiting — the loop survives. */
function renderPanelError(e: unknown): void {
  if (e instanceof ApiError) {
    // A genuine 401/403 = this instance is an authed server (authMode=local), not a
    // zero-auth desktop/loopback box. Tell the operator how to authenticate rather
    // than dump a raw status — the CLI never needs a PAT on a trusted local box.
    if (e.status === 401 || e.status === 403) {
      log.warn(
        "This instance requires authentication. Run `openship login` to paste a PAT, " +
          "or run the CLI on the box itself where loopback is trusted (zero-auth).",
      );
      return;
    }
    log.error(`${e.message}${e.status ? ` (${e.status})` : ""}`);
  } else {
    log.error(e instanceof Error ? e.message : String(e));
  }
}

/**
 * Is the API answering? Probes the PUBLIC /health of the active context's base
 * (via apiRaw, so it follows the same URL the data calls use — local or remote),
 * NOT a hardcoded loopback port. Reachability is the panel's gate; auth is only
 * consulted lazily, when a real data call comes back 401.
 */
async function apiLivePing(): Promise<boolean> {
  try {
    const res = await getRemoteClient().http.raw("/health", { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "cli/commands/edge");
    return false;
  }
}

/** Resolve (and cache) the local server id — GET /system/servers → the isLocal row. */
async function resolveLocalServerId(): Promise<string | null> {
  if (localServerId) return localServerId;
  const rows = await getRemoteClient().servers.list();
  const local = rows.find((r) => r.isLocal === true);
  localServerId = local?.id ?? null;
  return localServerId;
}

/**
 * Build the flat domain list. There's no org-wide domain endpoint, so we fan out over
 * projects (the ONLY place projects are touched) and read each project's domains —
 * the result is a flat, project-free `DomainEntry[]`. A domain's port is its own
 * `targetPort`, falling back to the project's port.
 */
async function loadDomains(): Promise<DomainEntry[]> {
  const entries: DomainEntry[] = [];
  const ship = getRemoteClient();
  for await (const p of iteratePages(page => ship.projects.list(page))) {
    const projectId = p.id;
    const projectPort = typeof p.port === "number" ? p.port : null;
    const domains = await ship.domains.list(projectId);
    for (const d of domains) {
      entries.push({
        id: d.id,
        hostname: d.hostname,
        port: (typeof d.targetPort === "number" ? d.targetPort : null) ?? projectPort,
        projectId,
        verified: !!d.verified,
        sslStatus: d.sslStatus ?? null,
        status: d.status ?? null,
      });
    }
  }
  return entries.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

// ── Host-side panel handlers (Linux; throw on failure, never exit) ───────────

async function panelStatus(): Promise<void> {
  const sp = spin("Diagnosing the edge…");
  const diag = await diagnoseEdge();
  sp?.stop();
  printDiagnosis(diag);
}

async function panelRepair(mode: RepairMode): Promise<void> {
  const sp = spin(mode === "migrate" ? "Migrating the existing proxy's sites…" : "Taking over :80/:443…");
  try {
    const { repairEdgeConflict } = await import("../lib/edge-preflight");
    sp?.stop();
    const res = await repairEdgeConflict(mode, apiPort(), onLog);
    renderRepair(res);
  } catch (e) {
    sp?.fail("Edge repair failed");
    throw e;
  }
}

async function panelUp(): Promise<void> {
  const sp = spin("Checking the edge…");
  const diag = await diagnoseEdge();
  sp?.stop();
  if (diag.healthy) {
    ok("  ✓ Edge is up and serving on :80/:443.");
    return;
  }
  printDiagnosis(diag);
  if (!diag.containerExists) {
    log.warn("No Openship edge container on this box — run `openship up` to install the stack.");
    return;
  }
  let mode: RepairMode;
  if (diag.sites.length > 0) {
    const choice = await select({
      message: `An existing proxy holds :80/:443 with ${diag.sites.length} site(s).`,
      options: [
        { value: "migrate", label: `Migrate ${diag.sites.length} site(s) & take over`, hint: "keep them serving" },
        { value: "stop", label: "Stop it & take over", hint: "its sites stop being served" },
        { value: "cancel", label: "Cancel" },
      ],
      initialValue: "migrate",
    });
    if (isCancel(choice) || choice === "cancel") {
      info("  Left the existing proxy running.");
      return;
    }
    mode = choice as RepairMode;
  } else {
    mode = "stop";
  }
  await panelRepair(mode);
}

async function panelSites(): Promise<void> {
  const sp = spin("Scanning for importable sites…");
  try {
    const executor = new LocalExecutor();
    const proxy = await detectInstalledProxy(executor);
    if (!proxy) {
      sp?.stop();
      info("  No importable reverse proxy found on this host.");
      return;
    }
    const { sites } = await scanImportableSites(executor, proxy);
    sp?.stop();
    info(`  Found ${proxy} with ${sites.length} site(s):`);
    printSites(sites);
  } catch (e) {
    sp?.fail("Scan failed");
    throw e;
  }
}

async function panelMonitoring(): Promise<void> {
  const existing = await detectExistingInstall();
  if (existing.present) {
    ok("  ✓ Openship is already installed — monitoring is available through the running instance.");
    await ensureEdgeBestEffort();
    return;
  }
  await ensureEdgeBestEffort();
  await runMonitoringInstall({ monitoring: true });
}

// ── Control-plane panel handlers (auth-gated; throw on failure) ──────────────

async function panelTraffic(entry: DomainEntry): Promise<void> {
  const serverId = await resolveLocalServerId();
  if (!serverId) {
    log.warn("No local server registered yet — enable monitoring first.");
    return;
  }
  const sp = spin(`Loading traffic for ${entry.hostname}…`);
  try {
    const buckets = await getRemoteClient().analytics.serverBuckets(serverId, { domain: entry.hostname });
    sp?.stop();
    if (!buckets.length) {
      info(`  No traffic recorded for ${entry.hostname} in the last hour.`);
      return;
    }
    let requests = 0;
    let bwIn = 0;
    let bwOut = 0;
    let rtSum = 0;
    const countries: Record<string, number> = {};
    for (const b of buckets) {
      requests += b.requests || 0;
      bwIn += b.bandwidthIn || 0;
      bwOut += b.bandwidthOut || 0;
      // responseTime is the minute's total (seconds), not its average.
      rtSum += b.responseTime || 0;
      for (const [cc, n] of Object.entries(b.countries ?? {})) countries[cc] = (countries[cc] || 0) + Number(n);
    }
    info(`  Traffic — ${entry.hostname}  ${chalk.dim("(last hour · server-scoped)")}`);
    info(`  Requests:   ${fmtInt(requests)}`);
    info(`  Bandwidth:  ↓ ${fmtBytes(bwIn)}   ↑ ${fmtBytes(bwOut)}`);
    info(`  Avg resp:   ${Math.round((requests ? rtSum / requests : 0) * 1000)} ms`);
    const top = Object.entries(countries).sort((a, b) => b[1] - a[1]).slice(0, 5);
    if (top.length) info(`  Top countries: ${top.map(([c, n]) => `${c}=${fmtInt(n)}`).join("   ")}`);
  } catch (e) {
    sp?.fail("Traffic load failed");
    throw e;
  }
}

async function panelAnalytics(entry: DomainEntry): Promise<void> {
  const serverId = await resolveLocalServerId();
  if (!serverId) {
    log.warn("No local server registered yet — enable monitoring first.");
    return;
  }
  const sp = spin(`Loading analytics for ${entry.hostname}…`);
  try {
    const g = await getRemoteClient().analytics.serverGeo(serverId, { domain: entry.hostname });
    sp?.stop();
    info(`  Analytics — ${entry.hostname}  ${chalk.dim("(today)")}`);
    info(`  Visitors:  ${fmtInt(g.visitors)}`);
    const countries = Object.entries(g.countries ?? {}).sort((a, b) => Number(b[1]) - Number(a[1]));
    if (countries.length) {
      info("\n  Countries:");
      printTable(
        countries.slice(0, 15).map(([c, n]) => ({ country: c, requests: fmtInt(Number(n)) })),
        ["country", "requests"],
      );
    } else {
      info(chalk.dim("  No geo data yet (no GeoIP database, or no traffic today)."));
    }
    const paths = Object.entries(g.paths ?? {}).sort((a, b) => Number(b[1]) - Number(a[1]));
    if (paths.length) {
      info("\n  Top paths:");
      printTable(
        paths.slice(0, 15).map(([p, n]) => ({ path: p, requests: fmtInt(Number(n)) })),
        ["path", "requests"],
      );
    }
    const statuses = Object.entries(g.statuses ?? {});
    if (statuses.length) info(`\n  Statuses:  ${statuses.map(([k, v]) => `${k}=${fmtInt(Number(v))}`).join("   ")}`);
  } catch (e) {
    sp?.fail("Analytics load failed");
    throw e;
  }
}

async function panelTrafficOverview(): Promise<void> {
  const serverId = await resolveLocalServerId();
  if (!serverId) {
    log.warn("No local server registered yet — enable monitoring first.");
    return;
  }
  const sp = spin("Loading domains…");
  const domains = await loadDomains();
  sp?.stop();
  if (!domains.length) {
    info("  No domains registered yet — use “Register a domain”.");
    return;
  }
  log.message(chalk.dim(`Fetching last-hour traffic for ${domains.length} domain(s)…`));
  const rows: Array<{ domain: string; port: string; requests: string; out: string }> = [];
  for (const d of domains) {
    let requests = 0;
    let bwOut = 0;
    try {
      const buckets = await getRemoteClient().analytics.serverBuckets(serverId, { domain: d.hostname });
      for (const b of buckets) {
        requests += b.requests || 0;
        bwOut += b.bandwidthOut || 0;
      }
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "cli/commands/edge");
      rows.push({ domain: d.hostname, port: d.port != null ? `:${d.port}` : "—", requests: "Unavailable", out: "Unavailable" });
      continue;
    }
    rows.push({
      domain: d.hostname,
      port: d.port != null ? `:${d.port}` : "—",
      requests: fmtInt(requests),
      out: fmtBytes(bwOut),
    });
  }
  printTable(rows, ["domain", "port", "requests", "out"]);
}

async function panelAddRule(entry: DomainEntry): Promise<void> {
  const type = await select({
    message: "Rule type",
    options: [
      { value: "rate", label: "Rate limit", hint: "requests/sec per client IP" },
      { value: "ban-country", label: "Ban countries", hint: "ISO-2 codes" },
      { value: "ban-ip", label: "Ban IPs" },
      { value: "allow-cidr", label: "Allow-list CIDRs", hint: "deny everything else" },
      { value: "block", label: "Block (status code)" },
    ],
  });
  if (isCancel(type)) return;

  const spec: Record<string, unknown> = {};
  if (type === "rate") {
    const rps = await promptRequired("Requests/second", "10");
    if (!rps) return;
    const n = parseInt(rps, 10);
    if (!Number.isFinite(n)) return void log.error("Not a number.");
    spec.rateLimit = { rps: n };
  } else if (type === "ban-country") {
    const cc = await promptRequired("Country codes (comma-separated)", "RU,CN");
    if (!cc) return;
    spec.ban = { countries: cc.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) };
  } else if (type === "ban-ip") {
    const ips = await promptRequired("IPs (comma-separated)", "1.2.3.4");
    if (!ips) return;
    spec.ban = { ips: ips.split(",").map((s) => s.trim()).filter(Boolean) };
  } else if (type === "allow-cidr") {
    const cidrs = await promptRequired("Allowed CIDRs (comma-separated)", "10.0.0.0/8");
    if (!cidrs) return;
    spec.access = { allowCidrs: cidrs.split(",").map((s) => s.trim()).filter(Boolean) };
  } else if (type === "block") {
    const code = await promptRequired("HTTP status to return", "403");
    if (!code) return;
    const n = parseInt(code, 10);
    if (!Number.isFinite(n)) return void log.error("Not a number.");
    spec.block = { status: n };
  }

  const sp = spin("Adding rule…");
  try {
    const rule = await getRemoteClient().projects.createRouteRule(entry.projectId, { domainId: entry.id, pathPrefix: null, spec, enabled: true });
    sp?.succeed(`Added rule ${rule.id}`);
  } catch (e) {
    sp?.fail("Add failed");
    throw e;
  }
}

async function panelRemoveRule(entry: DomainEntry, rules: RouteRule[]): Promise<void> {
  const options: Array<{ value: string; label: string }> = rules.map((r) => ({
    value: r.id,
    label: `${r.id}  ${Object.keys(r.spec ?? {}).join(",") || "(none)"}`,
  }));
  options.push({ value: "__cancel", label: "↩ Cancel" });
  const pick = await select({ message: "Remove which rule?", options });
  if (isCancel(pick) || pick === "__cancel") return;
  const sp = spin("Deleting rule…");
  try {
    await getRemoteClient().projects.removeRouteRule(entry.projectId, String(pick));
    sp?.succeed("Deleted.");
  } catch (e) {
    sp?.fail("Delete failed");
    throw e;
  }
}

async function panelRules(entry: DomainEntry): Promise<void> {
  for (;;) {
    const sp = spin("Loading route rules…");
    let rules: RouteRule[];
    try {
      rules = await getRemoteClient().projects.listRouteRules(entry.projectId);
      sp?.stop();
    } catch (e) {
      sp?.fail("Load failed");
      throw e;
    }
    // This domain's own rules plus any project-wide (null-domain) rules.
    const relevant = rules.filter((r) => !r.domainId || r.domainId === entry.id);
    if (relevant.length) {
      printTable(
        relevant.map((r) => ({
          id: r.id,
          scope: r.domainId === entry.id ? entry.hostname : "(all domains)",
          path: r.pathPrefix ?? "(all)",
          enabled: r.enabled === false ? "no" : "yes",
          rules: Object.keys(r.spec ?? {}).join(",") || "(none)",
        })),
        ["id", "scope", "path", "enabled", "rules"],
      );
    } else {
      info(`  No route rules for ${entry.hostname}.`);
    }

    const options: Array<{ value: string; label: string }> = [{ value: "add", label: "Add a rule" }];
    if (relevant.length) options.push({ value: "rm", label: "Remove a rule" });
    options.push({ value: "back", label: "↩ Back" });
    const act = await select({ message: `Route rules — ${entry.hostname}`, options });
    if (isCancel(act) || act === "back") return;
    try {
      if (act === "add") await panelAddRule(entry);
      else if (act === "rm") await panelRemoveRule(entry, relevant);
    } catch (e) {
      observeCaughtError(e, "cli/commands/edge");
      renderPanelError(e);
    }
  }
}

async function panelRegisterDomain(): Promise<void> {
  const hostname = await promptRequired("Hostname to register", "app.example.com");
  if (!hostname) return;
  const mode = await select({
    message: "Where does it point?",
    options: [
      { value: "port", label: "A port on this box", hint: "creates a tracked project" },
      { value: "project", label: "An existing project" },
    ],
    initialValue: "port",
  });
  if (isCancel(mode)) return;

  let opts: DomainAddOpts;
  if (mode === "port") {
    const portStr = await promptRequired("Port (127.0.0.1:<port>)", "3000");
    if (!portStr) return;
    const port = parseInt(portStr, 10);
    if (!Number.isFinite(port)) return void log.error("Not a valid port.");
    opts = { port };
  } else {
    const project = await promptRequired("Project ID");
    if (!project) return;
    opts = { project };
  }

  const sp = spin(`Registering ${hostname}…`);
  try {
    const res = await registerDomainCore(hostname, opts);
    sp?.succeed(res.verified ? `DNS verified for ${hostname}` : `Registered ${hostname}`);
    if (!isJsonMode() && res.routed) info(`  ${res.domain.hostname} is configured to be routed on the next deploy.`);
    if (res.verified) {
      if (res.sslStatus) info(`  SSL: ${res.sslStatus}`);
    } else if (res.records) {
      info("  Add these DNS records, then re-open this domain to verify:");
      printRecords(res.records);
    }
  } catch (e) {
    sp?.fail("Register failed");
    throw e;
  }
}

/** Returns true when the domain was removed (so the caller leaves the submenu). */
async function panelRemoveDomain(entry: DomainEntry): Promise<boolean> {
  const go = await confirm({ message: `Remove ${entry.hostname} from the edge?`, initialValue: false });
  if (isCancel(go) || !go) return false;
  const sp = spin(`Removing ${entry.hostname}…`);
  try {
    await getRemoteClient().domains.remove(entry.id);
    sp?.succeed(`Removed ${entry.hostname}`);
    return true;
  } catch (e) {
    sp?.fail("Remove failed");
    throw e;
  }
}

/** Actions for one domain — traffic/analytics use its projectId only under the hood. */
async function panelDomainActions(entry: DomainEntry): Promise<void> {
  for (;;) {
    const act = await select({
      message: `${entry.hostname}${entry.port != null ? ` → :${entry.port}` : ""}`,
      options: [
        { value: "traffic", label: "Traffic", hint: "requests + bandwidth (last hour)" },
        { value: "analytics", label: "Analytics", hint: "visitors, countries, paths (today)" },
        { value: "rules", label: "Route rules", hint: "rate-limit · ban · access" },
        { value: "rm", label: "Remove domain" },
        { value: "back", label: "↩ Back" },
      ],
    });
    if (isCancel(act) || act === "back") return;
    try {
      if (act === "traffic") await panelTraffic(entry);
      else if (act === "analytics") await panelAnalytics(entry);
      else if (act === "rules") await panelRules(entry);
      else if (act === "rm" && (await panelRemoveDomain(entry))) return;
    } catch (e) {
      observeCaughtError(e, "cli/commands/edge");
      renderPanelError(e);
    }
  }
}

/** The flat domain hub: a list of the domains the edge serves, plus register. */
async function panelDomains(): Promise<void> {
  await resolveLocalServerId(); // warm the cache so per-domain analytics resolve later
  for (;;) {
    const sp = spin("Loading domains…");
    let domains: DomainEntry[];
    try {
      domains = await loadDomains();
      sp?.stop();
    } catch (e) {
      sp?.fail("Load failed");
      throw e;
    }
    const options: Array<{ value: string; label: string; hint?: string }> = domains.map((d) => ({
      value: `d:${d.id}`,
      label: d.hostname,
      hint: `${d.port != null ? `:${d.port}` : "no port"} · ssl ${d.sslStatus ?? "none"} · ${d.verified ? "verified" : "unverified"}`,
    }));
    options.push({ value: "add", label: "＋ Register a domain" });
    options.push({ value: "back", label: "↩ Back" });
    const pick = await select({
      message: domains.length ? "Domains served by the edge" : "No domains yet",
      options,
    });
    if (isCancel(pick) || pick === "back") return;
    if (pick === "add") {
      try {
        await panelRegisterDomain();
      } catch (e) {
        observeCaughtError(e, "cli/commands/edge");
        renderPanelError(e);
      }
      continue;
    }
    const entry = domains.find((d) => `d:${d.id}` === pick);
    if (entry) await panelDomainActions(entry);
  }
}

// ── The panel loop ───────────────────────────────────────────────────────────

function edgeHeader(diag: EdgeDiagnosis | null, apiLive: boolean, domainsLabel: string): string {
  return [
    `Edge:      ${diag ? describeDiagnosis(diag) : chalk.dim("host ops unavailable (not Linux)")}`,
    `API:       ${apiLive ? chalk.green(`reachable · ${getRemoteClient().http.apiUrl}`) : chalk.dim(`unreachable · ${getRemoteClient().http.apiUrl}`)}`,
    `Domains:   ${domainsLabel}`,
  ].join("\n");
}

async function edgePanel(): Promise<void> {
  intro(`${chalk.bgCyan(chalk.black(" Openship "))}${chalk.dim(" edge")}`);
  for (;;) {
    const diag = IS_LINUX ? await diagnoseEdge().catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "cli/commands/edge"); return null; }) : null;
    const apiLive = await apiLivePing();

    // The edge CLI is a trusted local tool: on a desktop / loopback box the API is
    // zero-auth, so we just TRY the call — no PAT required. We gate the menu on
    // whether the API is REACHABLE, never on token presence. Auth only matters if a
    // real call comes back 401/403 (a self-hosted server with an admin), which we
    // detect here and surface as guidance rather than a dead-end "log in" screen.
    let domainsLabel = chalk.dim("—");
    let needsAuth = false;
    if (apiLive) {
      try {
        domainsLabel = String((await loadDomains()).length);
      } catch (e) {
        observeCaughtError(e, "cli/commands/edge");
        if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
          needsAuth = true;
          domainsLabel = chalk.yellow("auth required");
        } else {
          domainsLabel = chalk.dim("unavailable");
        }
      }
    }
    note(edgeHeader(diag, apiLive, domainsLabel), "Edge");

    const options: Array<{ value: string; label: string; hint?: string }> = [];
    if (apiLive) {
      options.push({ value: "domains", label: "Domains", hint: "browse · register · rules · analytics" });
      options.push({ value: "overview", label: "Traffic overview", hint: "requests + bandwidth per domain" });
    }
    if (IS_LINUX) {
      options.push({ value: "status", label: "Edge status (detailed)" });
      if (!diag?.healthy) options.push({ value: "up", label: "Bring up / repair the edge" });
      options.push({ value: "migrate", label: "Migrate an existing proxy's sites" });
      options.push({ value: "takeover", label: "Take over :80/:443", hint: "stop whatever holds them" });
      options.push({ value: "sites", label: "Scan for importable sites" });
      if (!apiLive) options.push({ value: "monitoring", label: "Enable monitoring", hint: "install the built-in analytics DB" });
    }
    options.push({ value: "recheck", label: "Re-run checks" });
    options.push({ value: "quit", label: "Quit" });

    // A sparse menu shouldn't be a mystery — explain WHY the control-plane half is
    // absent (API down) or restricted (real auth needed).
    if (!apiLive) {
      note(
        `The Openship API isn't answering at ${getRemoteClient().http.apiUrl}.\n` +
          "Domains, traffic & analytics need it — start the stack with `openship up`.",
        "API offline",
      );
    } else if (needsAuth) {
      note(
        "This instance requires authentication (a server with an admin, not a zero-auth\n" +
          "desktop box). Run `openship login` to paste a PAT, or run the CLI on the box\n" +
          "itself where loopback is trusted.",
        "Auth required",
      );
    }

    const action = await select({ message: "What would you like to do?", options, initialValue: options[0]?.value });
    if (isCancel(action) || action === "quit") {
      outro(chalk.dim("Bye."));
      return;
    }
    if (action === "recheck") continue;
    try {
      if (action === "domains") await panelDomains();
      else if (action === "overview") await panelTrafficOverview();
      else if (action === "status") await panelStatus();
      else if (action === "up") await panelUp();
      else if (action === "migrate") await panelRepair("migrate");
      else if (action === "takeover") await panelRepair("stop");
      else if (action === "sites") await panelSites();
      else if (action === "monitoring") await panelMonitoring();
    } catch (e) {
      observeCaughtError(e, "cli/commands/edge");
      renderPanelError(e);
    }
  }
}

// ─── Control-plane: route rules ──────────────────────────────────────────────

/** Commander collector for repeatable/comma-separated list flags. */
const collect = (v: string, acc: string[] = []): string[] => acc.concat(v.split(",").map((s) => s.trim()).filter(Boolean));

const rulesList = new Command("list")
  .description("List a project's edge route rules")
  .requiredOption("-p, --project <id>", "Project ID")
  .action(async (opts) => {
    try {
      const rules = await getRemoteClient().projects.listRouteRules(opts.project);
      if (isJsonMode()) {
        printJson(rules);
        return;
      }
      printTable(
        rules.map((r) => ({
          id: r.id,
          path: r.pathPrefix ?? "(all)",
          domain: r.domainId ?? "(all)",
          enabled: r.enabled === false ? "no" : "yes",
          rules: Object.keys(r.spec ?? {}).join(",") || "(none)",
        })),
        ["id", "path", "domain", "enabled", "rules"],
      );
    } catch (e) {
      observeCaughtError(e, "cli/commands/edge");
      fail(e);
    }
  });

const rulesAdd = new Command("add")
  .description("Add an edge route rule (rate-limit · ban · access · block)")
  .requiredOption("-p, --project <id>", "Project ID")
  .option("--path <prefix>", "Scope the rule to a path prefix (default: whole project)")
  .option("--domain <id>", "Scope the rule to one domain of the project")
  .option("--rate-limit <rps>", "Requests/second per client IP before throttling", positiveInteger)
  .option("--burst <n>", "Burst allowance for --rate-limit", positiveInteger)
  .option("--ban-country <cc>", "Block ISO-2 country code(s) (repeatable/comma-separated)", collect)
  .option("--ban-ip <ip>", "Block IP address(es) (repeatable/comma-separated)", collect)
  .option("--deny-cidr <cidr>", "Deny CIDR range(s) (repeatable/comma-separated)", collect)
  .option("--allow-cidr <cidr>", "Allow-list CIDR range(s) — everything else is denied", collect)
  .option("--allow-country <cc>", "Allow-list ISO-2 country code(s) — everything else denied", collect)
  .option("--block-status <code>", "HTTP status returned on block (401/403/404/429/444/451/503)", positiveInteger)
  .option("--disabled", "Create the rule disabled", false)
  .action(async (opts) => {
    const spec: Record<string, unknown> = {};
    if (Number.isFinite(opts.rateLimit)) {
      spec.rateLimit = { rps: opts.rateLimit, ...(Number.isFinite(opts.burst) ? { burst: opts.burst } : {}) };
    }
    const ban: Record<string, unknown> = {};
    if (opts.banCountry?.length) ban.countries = opts.banCountry;
    if (opts.banIp?.length) ban.ips = opts.banIp;
    if (Object.keys(ban).length) spec.ban = ban;
    const access: Record<string, unknown> = {};
    if (opts.denyCidr?.length) access.denyCidrs = opts.denyCidr;
    if (opts.allowCidr?.length) access.allowCidrs = opts.allowCidr;
    if (opts.allowCountry?.length) access.allowCountries = opts.allowCountry;
    if (Object.keys(access).length) spec.access = access;
    if (Number.isFinite(opts.blockStatus)) spec.block = { status: opts.blockStatus };

    if (Object.keys(spec).length === 0) {
      err("  Nothing to add — pass at least one rule flag (see `openship edge rules add --help`).");
      process.exit(1);
    }

    const sp = spin("Adding route rule…");
    try {
      const rule = await getRemoteClient().projects.createRouteRule(opts.project, {
        domainId: opts.domain ?? null, pathPrefix: opts.path ?? null, spec, enabled: !opts.disabled,
      });
      sp?.succeed(`Added rule ${rule.id}`);
      if (isJsonMode()) printJson(rule);
    } catch (e) {
      observeCaughtError(e, "cli/commands/edge");
      sp?.fail("Add failed");
      fail(e);
    }
  });

const rulesRm = new Command("rm")
  .description("Delete an edge route rule")
  .requiredOption("-p, --project <id>", "Project ID")
  .argument("<ruleId>", "Route rule ID")
  .action(async (ruleId: string, opts) => {
    const sp = spin("Deleting route rule…");
    try {
      await getRemoteClient().projects.removeRouteRule(opts.project, ruleId);
      sp?.succeed(`Deleted rule ${ruleId}`);
      if (isJsonMode()) printJson({ success: true });
    } catch (e) {
      observeCaughtError(e, "cli/commands/edge");
      sp?.fail("Delete failed");
      fail(e);
    }
  });

const rulesCommand = new Command("rules")
  .description("Per-route edge rules: rate-limit, ban, access control")
  .addCommand(rulesList)
  .addCommand(rulesAdd)
  .addCommand(rulesRm);

// ─── Control-plane: domains (register a host on a port, verify SSL, remove) ──

/** Render a DNS-records result: mode line + type/host/value table (mirrors `openship domain`). */
function printRecords(result: DomainRecords): void {
  if (isJsonMode()) {
    printJson(result);
    return;
  }
  info(`  DNS mode: ${result.mode}`);
  printTable(
    result.records.map((r) => ({ type: r.type, host: r.host, value: r.value })),
    ["type", "host", "value"],
  );
}

const domainsList = new Command("list")
  .description("List a project's domains routed through the edge")
  .requiredOption("-p, --project <id>", "Project ID")
  .action(async (opts) => {
    try {
      const rows = await getRemoteClient().domains.list(opts.project);
      if (isJsonMode()) {
        printJson(rows);
        return;
      }
      printTable(
        rows.map((d) => ({
          id: d.id,
          hostname: d.hostname,
          type: d.domainType ?? "",
          primary: d.isPrimary ? "yes" : "",
          verified: d.verified ? "yes" : "no",
          ssl: d.sslStatus ?? "",
        })),
        ["id", "hostname", "type", "primary", "verified", "ssl"],
      );
    } catch (e) {
      observeCaughtError(e, "cli/commands/edge");
      fail(e);
    }
  });

interface DomainAddOpts {
  project?: string;
  port?: number;
  primary?: boolean;
  verify?: boolean; // commander default true; --no-verify → false
}

/**
 * Register a hostname on the edge. Two ways to say where it points:
 *   --project <id>  → attach to an existing project (its port is the target)
 *   --port <n>      → auto-create a minimal tracked project bound to 127.0.0.1:<n>
 * Exactly one is required. This is the same pipeline as `openship domain add` plus
 * an inline project-create for the port case, so the domain is analytics-eligible
 * (per-domain analytics need domain→project→server).
 */
interface RegisterResult {
  routed: boolean;
  domain: Domain;
  records?: DomainRecords;
  verified: boolean;
  sslStatus?: string;
  projectId?: string;
}

/**
 * Register a hostname on the edge: create a tracked project for the --port case,
 * `POST /domains`, then (unless --no-verify) best-effort verify + issue SSL. Returns
 * the outcome and THROWS `ApiError` on a hard failure — the caller decides whether to
 * exit (the verb) or render-and-continue (the panel). 422 (DNS not propagated) is not
 * a failure, per [[domains-never-fail-deploy]].
 */
async function registerDomainCore(hostname: string, opts: DomainAddOpts): Promise<RegisterResult> {
  const host = hostname.trim().toLowerCase();
  const hasProject = Boolean(opts.project);
  const hasPort = opts.port != null && Number.isFinite(opts.port);
  if (hasProject === hasPort) {
    throw new ApiError(
      "Pass exactly one of --project <id> or --port <n> (project supplies the target port, or bind a new one).",
      400,
      null,
    );
  }

  let projectId = opts.project;
  // Validate the hostname before creating the optional tracking project.
  const input = parseInput(CreateDomainInputSchema, { hostname: host, isPrimary: !!opts.primary });
  const ship = getRemoteClient();
  if (hasPort) {
    const created = await ship.projects.create({ name: host, port: opts.port });
    projectId = created.id;
  }

  const added = await ship.domains.create(projectId!, input);
  const domain = added.domain;
  const routed = await attachCustomDomainEndpoint(ship, projectId!, domain.hostname);

  let verified = false;
  let sslStatus: string | undefined;
  if (opts.verify !== false) {
    const vbody = await ship.domains.verify(domain.id);
    verified = !!vbody.verified;
    sslStatus = vbody.sslStatus;
  }

  return { domain, records: added.records, verified, sslStatus, projectId, routed };
}

async function runDomainAdd(hostname: string, opts: DomainAddOpts): Promise<void> {
  const host = hostname.trim().toLowerCase();
  const sp = spin(`Registering ${host}…`);
  try {
    const res = await registerDomainCore(hostname, opts);
    sp?.succeed(res.verified ? `DNS verified for ${host}` : `Registered ${host}`);
    if (!isJsonMode() && res.routed) info(`  ${res.domain.hostname} is configured to be routed on the next deploy.`);
    if (isJsonMode()) {
      printJson({ domain: res.domain, records: res.records, verified: res.verified, sslStatus: res.sslStatus, projectId: res.projectId });
      return;
    }
    if (res.verified) {
      if (res.sslStatus) info(`  SSL: ${res.sslStatus}`);
    } else {
      info(`  Add these DNS records at your registrar, then run \`openship domain verify ${res.domain.id}\`:`);
      if (res.records) printRecords(res.records);
    }
  } catch (e) {
    observeCaughtError(e, "cli/commands/edge");
    sp?.fail("Register failed");
    fail(e);
  }
}

/** Remove a hostname from the edge (looked up by name within a project). */
async function runDomainRm(hostname: string, opts: { project: string }): Promise<void> {
  const host = hostname.trim().toLowerCase();
  const sp = spin(`Removing ${host}…`);
  try {
    const domains = await getRemoteClient().domains.list(opts.project);
    const match = domains.find((d) => d.hostname.toLowerCase() === host);
    if (!match) {
      sp?.fail("Not found");
      err(`  No domain ${host} on project ${opts.project}.`);
      process.exit(1);
    }
    await getRemoteClient().domains.remove(match.id);
    sp?.succeed(`Removed ${host}`);
    if (isJsonMode()) printJson({ success: true, id: match.id, hostname: host });
  } catch (e) {
    observeCaughtError(e, "cli/commands/edge");
    sp?.fail("Remove failed");
    fail(e);
  }
}

const domainsAdd = new Command("add")
  .description("Register a hostname for routing on the next deploy (auto-verifies SSL)")
  .argument("<hostname>", "Domain hostname (e.g. app.example.com)")
  .option("-p, --project <id>", "Attach to an existing project (uses its target port)")
  .option("--port <n>", "Bind a new tracked project to 127.0.0.1:<n>", positiveInteger)
  .option("--primary", "Mark this domain as the project's primary", false)
  .option("--no-verify", "Skip DNS verification + SSL issuance (still configure routing)")
  .action((hostname: string, opts) => runDomainAdd(hostname, opts));

const domainsRm = new Command("rm")
  .description("Remove a hostname from the edge")
  .argument("<hostname>", "Domain hostname to remove")
  .requiredOption("-p, --project <id>", "Project the domain belongs to")
  .action((hostname: string, opts) => runDomainRm(hostname, opts));

const domainsCommand = new Command("domains")
  .alias("domain")
  .description("Domains routed through the edge: list, register on a port, verify SSL, remove")
  .addCommand(domainsList)
  .addCommand(domainsAdd)
  .addCommand(domainsRm);

// ─── Control-plane: request logs ─────────────────────────────────────────────

function printLogRows(rows: unknown[]): void {
  printTable(
    rows.filter(isRecord).map((r) => ({
      time: String(r.ts ?? r.timestamp ?? ""),
      host: String(r.host ?? ""),
      ip: String(r.ip ?? ""),
      method: String(r.method ?? ""),
      status: String(r.status ?? r.statusCode ?? ""),
      path: String(r.path ?? ""),
    })),
    ["time", "host", "ip", "method", "status", "path"],
  );
}

const logsCommand = new Command("logs")
  .description("Recent HTTP request logs the edge captured for a project")
  .requiredOption("-p, --project <id>", "Project ID")
  .option("--limit <n>", "How many recent entries to fetch (max 200)", positiveInteger, 50)
  .option("--follow", "Stream new entries through the SDK's authorized Cloud or self-hosted connection", false)
  .action(async (opts) => {
    try {
      if (opts.follow) {
        await printEvents(getRemoteClient().projects.streamServerLogs(opts.project));
        return;
      }
      const { logs: rows } = await getRemoteClient().projects.recentServerLogs(opts.project, { limit: opts.limit });
      if (isJsonMode()) {
        printJson(rows);
        return;
      }
      if (rows.length === 0) info("  No request logs yet.");
      else printLogRows(rows);

    } catch (e) {
      observeCaughtError(e, "cli/commands/edge");
      fail(e);
    }
  });

// ─── Control-plane: traffic overview (GET /analytics/overview) ───────────────

interface TrafficOpts {
  project: string;
  domain?: string;
  from?: string;
  to?: string;
}

async function runTraffic(opts: TrafficOpts): Promise<void> {
  try {
    const result = await getRemoteClient().analytics.overview(opts.project, { domain: opts.domain, from: opts.from, to: opts.to });
    if (isJsonMode()) {
      printJson(result);
      return;
    }
    const s = result.summary;
    info(`  Traffic — ${opts.project}${opts.domain ? ` · ${opts.domain}` : ""}`);
    info(`  Requests:        ${fmtInt(s.totalRequests)}  ${chalk.dim(`(page ${fmtInt(s.pageRequests)})`)}`);
    info(
      `  Unique visitors: ${s.uniqueVisitors == null ? chalk.dim("— (see `edge analytics`)") : fmtInt(s.uniqueVisitors)}`,
    );
    info(`  Bandwidth:       ↓ ${fmtBytes(s.bandwidthIn)}   ↑ ${fmtBytes(s.bandwidthOut)}`);
    info(`  Avg response:    ${Math.round(s.avgResponseTimeMs || 0)} ms`);
    info(`  Last updated:    ${s.lastUpdated ?? "—"}`);
    const periods = result.periods;
    if (periods.length) {
      info("");
      printTable(
        periods.map((p) => ({
          from: p.from,
          requests: fmtInt(p.requests),
          visitors: fmtInt(p.uniqueVisitors),
          out: fmtBytes(p.bandwidthOut),
        })),
        ["from", "requests", "visitors", "out"],
      );
    }
  } catch (e) {
    observeCaughtError(e, "cli/commands/edge");
    fail(e);
  }
}

const trafficCommand = new Command("traffic")
  .description("Traffic overview for a project (requests, bandwidth, hourly periods)")
  .requiredOption("-p, --project <id>", "Project ID")
  .option("--domain <host>", "Scope to a single tracked domain")
  .option("--from <ts>", "Window start (ISO 8601)")
  .option("--to <ts>", "Window end (ISO 8601)")
  .action((opts) => runTraffic(opts));

// ─── Control-plane: per-domain analytics (GET /analytics/geo) ────────────────

interface GeoOpts {
  project: string;
  domain?: string;
  from?: string;
  to?: string;
}

async function runGeo(opts: GeoOpts): Promise<void> {
  try {
    const g = await getRemoteClient().analytics.geo(opts.project, { domain: opts.domain, from: opts.from, to: opts.to });
    if (isJsonMode()) {
      printJson(g);
      return;
    }
    info(
      `  Analytics — ${opts.project}${opts.domain ? ` · ${opts.domain}` : ""}  ${chalk.dim(`(source: ${g.source})`)}`,
    );
    info(`  Requests:      ${fmtInt(g.total)}`);
    info(
      `  Visitor-days:  ${fmtInt(g.visitorDays)}  ${chalk.dim(`(peak day ${fmtInt(g.peakDayVisitors)})`)}${g.approximate ? chalk.yellow("  ~approx") : ""}`,
    );
    if (!g.geoAvailable) {
      info(chalk.yellow("  Geo lookup unavailable on this edge (no GeoIP database installed)."));
    }
    if (g.countries.length) {
      info("\n  Countries:");
      printTable(
        g.countries.map((c) => ({ country: c.code, requests: fmtInt(c.count), pct: `${c.pct}%` })),
        ["country", "requests", "pct"],
      );
    }
    if (g.topPaths.length) {
      info("\n  Top paths:");
      printTable(
        g.topPaths.map((p) => ({ path: p.path, requests: fmtInt(p.count) })),
        ["path", "requests"],
      );
    } else if (!g.pathsEnabled) {
      info(chalk.dim("\n  Top-path collection is off — enable per-path aggregation in the dashboard to populate it."));
    }
    const statuses = Object.entries(g.statuses ?? {});
    if (statuses.length) info(`\n  Statuses:  ${statuses.map(([k, v]) => `${k}=${fmtInt(v)}`).join("   ")}`);
  } catch (e) {
    observeCaughtError(e, "cli/commands/edge");
    fail(e);
  }
}

const analyticsCommand = new Command("analytics")
  .description("Per-domain analytics for a project: visitors, countries, top paths")
  .requiredOption("-p, --project <id>", "Project ID")
  .option("--domain <host>", "Scope to a single tracked domain")
  .option("--from <ts>", "Window start (ISO 8601 or epoch ms; default 7 days)")
  .option("--to <ts>", "Window end")
  .action((opts) => runGeo(opts));

// ─── Install / optional monitoring ───────────────────────────────────────────

interface InstallOpts {
  migrate?: boolean;
  takeover?: boolean;
  /** Tri-state: undefined = decide (prompt on TTY, edge-only headless); true/false explicit. */
  monitoring?: boolean;
  adminName?: string;
  adminEmail?: string;
  adminPassword?: string;
}

/**
 * Is a full Openship already installed on this box? Reuses the same primitives the
 * rest of the CLI trusts — a bare service unit, a recorded compose install, or a
 * live API answering on the configured loopback port. Any one = "already here".
 */
async function detectExistingInstall(): Promise<{
  present: boolean;
  method: "compose" | "bare" | null;
  running: boolean;
  apiLive: boolean;
}> {
  const svc = serviceStatus();
  const method = readInstallMethod();
  let apiLive = false;
  try {
    const res = await fetch(`http://127.0.0.1:${storedApiPort()}/api/health`, {
      signal: AbortSignal.timeout(2000),
    });
    apiLive = res.ok;
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "cli/commands/edge");
    // not live — leave apiLive false
  }
  return { present: svc.installed || method !== null || apiLive, method, running: svc.running, apiLive };
}

/** Diagnose the edge and print a one-line status — never mutates, never exits.
 *  Lets the monitoring install proceed regardless of the edge's current state. */
async function ensureEdgeBestEffort(): Promise<void> {
  try {
    const diag = await diagnoseEdge();
    info(`  Edge: ${describeDiagnosis(diag)}`);
    if (!diag.containerExists) {
      info(chalk.dim("        No edge container yet — `openship up` brings one up on :80/:443."));
    } else if (!diag.healthy) {
      info(chalk.dim("        Edge isn't serving — `openship edge up` repairs it."));
    }
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "cli/commands/edge");
    // best-effort only
  }
}

function printMonitoringNextSteps(): void {
  info("\n  Monitoring is on — the built-in database now collects edge analytics.");
  info("  Next:");
  info("    openship login                                  paste a PAT from the dashboard to read analytics");
  info("    openship edge migrate                           track sites already on the edge");
  info("    openship edge domain add <host> --port <n>      register a new domain on a port");
  info("    openship edge traffic   -p <project>            traffic overview");
  info("    openship edge analytics -p <project>            per-domain analytics");
}

/**
 * Stand up monitoring by installing the standard bare Openship service (embedded
 * PGlite) — the exact `openship up --bare` pipeline, no new data layer. Prompts for
 * admin credentials on a TTY; headless requires --admin-email + a password
 * (flag or OPENSHIP_ADMIN_PASSWORD). Exits when done.
 */
/**
 * Stand up monitoring by installing the standard bare Openship service (embedded
 * PGlite) — the exact `openship up --bare` pipeline, no new data layer. Prompts for
 * admin credentials on a TTY; headless requires --admin-email + a password (flag or
 * OPENSHIP_ADMIN_PASSWORD). Returns true when installed, false when the operator
 * cancels at a credential prompt; THROWS on a hard install failure (caller decides
 * exit vs. continue).
 */
async function runMonitoringInstall(opts: InstallOpts): Promise<boolean> {
  const up = await import("./up");

  let adminName = opts.adminName;
  let adminEmail = opts.adminEmail;
  let adminPassword = opts.adminPassword;

  const needsCreds = !adminEmail || !(adminPassword || process.env.OPENSHIP_ADMIN_PASSWORD);
  if (needsCreds && interactive && !isJsonMode()) {
    const nm = await text({ message: "Admin name", placeholder: "Admin", initialValue: adminName });
    if (isCancel(nm)) {
      info("  Cancelled.");
      return false;
    }
    adminName = String(nm ?? "").trim() || "Admin";
    const em = await text({
      message: "Admin email",
      initialValue: adminEmail,
      validate: (v) => (/^\S+@\S+\.\S+$/.test(String(v ?? "")) ? undefined : "Enter a valid email"),
    });
    if (isCancel(em)) {
      info("  Cancelled.");
      return false;
    }
    adminEmail = String(em).trim();
    const pw = await password({
      message: "Admin password (min 8 chars)",
      validate: (v) => (String(v ?? "").length >= 8 ? undefined : "At least 8 characters"),
    });
    if (isCancel(pw)) {
      info("  Cancelled.");
      return false;
    }
    adminPassword = String(pw);
  }

  // Same install as `openship up --bare`: PGlite, no public domain, no managed
  // edge (leaving the edge container untouched). UpOpts isn't exported — reach its
  // shape through startService's parameter type.
  const monOpts = {
    ...opts,
    bare: true,
    domainKind: "none",
    adminName,
    adminEmail,
    adminPassword,
  } as unknown as Parameters<typeof up.startService>[0];

  const sp = spin("Installing the built-in Openship service (embedded database)…");
  let started: { port: string; dashPort: string };
  try {
    started = await up.startService(monOpts, { quiet: true });
    sp?.stop();
  } catch (e) {
    sp?.fail("Install failed");
    throw e;
  }
  await up.runHeadlessProvision(monOpts, started, { method: "bare" });
  if (!isJsonMode()) printMonitoringNextSteps();
  else printJson({ monitoring: true, apiPort: started.port, dashboardPort: started.dashPort });
  return true;
}

/** Verb wrapper: install monitoring, then exit (0 on install/cancel, 1 on failure). */
async function provisionMonitoring(opts: InstallOpts): Promise<never> {
  try {
    await runMonitoringInstall(opts);
  } catch (e) {
    observeCaughtError(e, "cli/commands/edge");
    fail(e);
  }
  process.exit(0);
}

/**
 * `edge up`/`install`: ensure the edge is serving, and — when asked — turn on
 * monitoring by reusing the bare-install pipeline. Detect-first: if a full
 * Openship already exists, monitoring is already available and we change nothing.
 */
async function runInstall(opts: InstallOpts): Promise<never> {
  requireLinux();

  // --no-monitoring, or headless with no explicit choice → today's edge-only behavior.
  if (opts.monitoring === false) return runUp(opts);
  const explicit = opts.monitoring === true;
  const canPrompt = interactive && !isJsonMode();
  if (!explicit && !canPrompt) return runUp(opts);

  const existing = await detectExistingInstall();
  if (existing.present) {
    // Interactive but monitoring wasn't requested → this is just an edge repair.
    if (!explicit) return runUp(opts);
    // Explicit --monitoring on a box that already has Openship: nothing to provision.
    ok("  ✓ Openship is already installed — monitoring is available through the running instance.");
    info(
      `    Install: ${existing.method ?? "service"}${existing.apiLive ? ", API live" : existing.running ? ", running" : ""}`,
    );
    await ensureEdgeBestEffort();
    info("\n  Nothing to change. Read analytics with `openship edge traffic -p <project>` (run `openship login` first).");
    process.exit(0);
  }

  // No Openship yet.
  if (explicit) {
    await ensureEdgeBestEffort();
    return provisionMonitoring(opts);
  }
  // Interactive, no flag, no install → offer monitoring.
  const yes = await confirm({
    message:
      "Enable monitoring (traffic + per-domain analytics)? Installs the built-in Openship service with an embedded database.",
    initialValue: false,
  });
  if (isCancel(yes) || !yes) return runUp(opts);
  await ensureEdgeBestEffort();
  return provisionMonitoring(opts);
}

// ─── Parent group ────────────────────────────────────────────────────────────

const statusCmd = new Command("status")
  .description("Show whether the edge is installed and serving :80/:443")
  .action(() => runStatus({}));

const upCmd = new Command("up")
  .alias("install")
  .alias("start")
  .description("Ensure the edge is up and serving; optionally enable monitoring (built-in analytics DB)")
  .option("--migrate", "On a port conflict, import the existing proxy's sites and take over")
  .option("--takeover", "On a port conflict, stop whatever holds :80/:443 (its sites drop)")
  // Declare --monitoring BEFORE --no-monitoring so the default stays undefined
  // (tri-state): unset = decide, --monitoring = true, --no-monitoring = false.
  .option("--monitoring", "Also enable monitoring: install the built-in Openship service + embedded DB for analytics")
  .option("--no-monitoring", "Edge only — skip the monitoring prompt (the headless default)")
  .option("--admin-name <name>", "Admin display name for a fresh monitoring install")
  .option("--admin-email <email>", "Admin email for a fresh monitoring install (required when headless)")
  .option("--admin-password <pw>", "Admin password (prefer the OPENSHIP_ADMIN_PASSWORD env var)")
  .action((opts) => runInstall(opts));

const migrateCmd = new Command("migrate")
  .description("Take over :80/:443 and import the existing proxy's sites into the edge")
  .action(() => runRepair("migrate"));

const takeoverCmd = new Command("takeover")
  .description("Free :80/:443 for the edge — whatever holds them is stopped and its sites drop")
  .action(() => runRepair("stop"));

const sitesCmd = new Command("sites")
  .alias("scan")
  .description("List reverse-proxy sites on this host that the edge could import")
  .action(() => scanSites());

const repairCmd = new Command("repair")
  .alias("doctor")
  .description("Diagnose why the edge isn't serving; --fix to resolve a port conflict")
  .option("--fix", "Attempt to fix a detected conflict (default: migrate its sites)", false)
  .option("--migrate", "With --fix: import the existing proxy's sites")
  .option("--takeover", "With --fix: stop whatever holds :80/:443 (sites drop)")
  .action((opts) => runStatus(opts));

export const edgeCommand = new Command("edge")
  .description("Install and manage the OpenResty edge (reverse proxy, TLS, per-route rules)")
  .addCommand(statusCmd)
  .addCommand(upCmd)
  .addCommand(migrateCmd)
  .addCommand(takeoverCmd)
  .addCommand(sitesCmd)
  .addCommand(repairCmd)
  .addCommand(rulesCommand)
  .addCommand(domainsCommand)
  .addCommand(trafficCommand)
  .addCommand(analyticsCommand)
  .addCommand(logsCommand)
  // Bare `openship edge`:
  //   • Any TTY (incl. macOS/Windows) → the looping interactive panel. Host-side ops
  //     are Linux-gated *inside* the panel; the control-plane half (domains, traffic,
  //     analytics, rules) works anywhere, so the panel is useful off-Linux too.
  //   • Linux, non-TTY / JSON → the status readout (scriptable, unchanged).
  //   • non-Linux, non-TTY → just print help (nothing scriptable to show).
  .action(async function (this: Command) {
    if (interactive && !isJsonMode()) {
      await edgePanel();
      return;
    }
    if (process.platform === "linux") await runStatus({});
    else this.help();
  });
