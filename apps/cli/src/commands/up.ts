import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDashboard } from "../lib/dashboard";
import { installAndStart } from "../lib/service";
import {
  composeUp,
  composePrefetch,
  ensureDocker,
  composeInternalToken,
  composeTrustedOriginUrls,
  hasDockerCompose,
  resolveComposePorts,
  sourceBuildDir,
} from "../lib/compose";
import { planMethod, planUp, renderUpPlan } from "../lib/up-plan";
import { portMoveNotice, readInstanceUrl, resolvePorts } from "../lib/ports";
import { prepareFromSource, type FromSourceRun } from "../lib/from-source";
import {
  markStoppedProxyImported,
  planAndApplyHostEdge,
  rollbackHostEdge,
  completeHostEdge,
  type EdgeAction,
} from "../lib/edge-preflight";
import { importMigratedSites } from "../lib/edge-import";
import { edgeIsBroken, edgeCrashReason } from "@repo/adapters/proxy";
import { LocalExecutor } from "@repo/adapters";
import {
  resolveInstallInputs,
  headlessProvision,
  HeadlessInputError,
} from "../lib/instance-provision";
import { ensureInternalToken } from "../lib/loopback-api";
import { AUTH_SECRET_FILE, DATA_DIR, LOG_DIR, OS_DIR } from "../lib/paths";
import type { ImportedSite } from "@repo/adapters/proxy";

const EDGE_ACTIONS: EdgeAction[] = ["migrate", "takeover", "cancel"];

interface UpOpts {
  port?: string;
  dataDir?: string;
  dashboardPort?: string;
  ui?: boolean;
  uiVersion?: string;
  foreground?: boolean;
  dryRun?: boolean;
  publicUrl?: string;
  trustProxy?: boolean;
  /** Bind the dashboard to this interface (e.g. 0.0.0.0 or a LAN IP) so an
   *  upstream reverse proxy can reach it; default 127.0.0.1 (loopback). */
  host?: string;
  /** Install OpenResty + Let's Encrypt on this box and route --public-url here. */
  managedEdge?: boolean;
  /** ACME contact email for the managed edge. */
  acmeEmail?: string;
  /** Preview mode: build + run from source (a branch) instead of a published release. */
  fromSource?: boolean;
  /** Git branch/tag/sha to build with --from-source (default: main). */
  ref?: string;
  /** Build from an existing local checkout instead of cloning. */
  source?: string;
  /** Git remote to clone for --from-source (default: oblien/openship). */
  repo?: string;
  /** Install via Docker Compose (published images). Default when Docker is present on Linux. */
  compose?: boolean;
  /** Force the bare process service (the pre-compose install). */
  bare?: boolean;
  /** Non-interactive answer for the compose edge preflight when a foreign proxy holds :80/:443. */
  edge?: string;
  /** Withhold the api's channel to the HOST OS (hardening; see --no-host-control). */
  hostControl?: boolean;
  /** Headless install: after the service is up, create the admin + register the
   *  domain from flags instead of prompting. Requires --admin-email + password. */
  nonInteractive?: boolean;
  adminName?: string;
  adminEmail?: string;
  /** Prefer OPENSHIP_ADMIN_PASSWORD env over the flag (keeps it out of argv). */
  adminPassword?: string;
  /** byo | custom | free | none (default: byo when --public-url set, else none). */
  domainKind?: string;
  hostname?: string;
  slug?: string;
}

/** Normalize a URL/host to `scheme://host`, or null if unparseable. Shared with
 *  the setup wizard so there's one URL-normalization rule. */
export function normalizeUrl(raw: string): string | null {
  const value = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(value);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * The public URL this run serves on: the flag, else the one this install is
 * ALREADY configured with (`~/.openship/instance.json`).
 *
 * A plain `openship up` — the natural thing to do after `openship update` — used
 * to drop it, and `OPENSHIP_PUBLIC_URL` is what puts the operator's domain in the
 * API's `trustedOrigins`. Losing it leaves an install that still serves reads and
 * 403s every mutation with `ORIGIN_REJECTED`, naming neither cause nor fix.
 *
 * A saved LOOPBACK url is deliberately not carried: that's the "no domain" value
 * the wizard records, and handing it to OPENSHIP_PUBLIC_URL would tell the API it
 * is publicly served when it isn't (which changes auth-mode and cookie gates).
 * To clear a real one, edit `.env` and re-run — the edit is now preserved.
 */
function effectivePublicUrl(flag?: string): string | undefined {
  if (flag) return normalizePublicUrl(flag);
  const saved = readInstanceUrl();
  if (!saved || /^https?:\/\/(localhost|127\.|\[?::1\]?)([:/]|$)/i.test(saved)) return undefined;
  return normalizePublicUrl(saved);
}

/** Normalize a --public-url value, or exit with a hint if it's malformed. */
function normalizePublicUrl(raw: string): string {
  const url = normalizeUrl(raw);
  if (!url) {
    console.error(
      chalk.red(`\n  Invalid --public-url: ${raw}`) +
        chalk.dim("\n  Expected something like https://ops.example.com\n"),
    );
    process.exit(1);
  }
  return url;
}

// Inlined at build time by tsup (see tsup.config.ts `define`). Used to pin the
// dashboard bundle to this CLI's release so the API and UI versions match.
declare const __CLI_VERSION__: string;

// dist/ (this file is bundled into dist/index.js); the API bundle staged by
// build/stage-server.ts lives alongside it at dist/server/.
const DIST_DIR = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(DIST_DIR, "server");

// ensureInternalToken lives in lib/loopback-api (shared with the wizard + headless
// installer — single copy, imported above). Re-exported so existing importers of
// `ensureInternalToken` from "./up" (reset-admin, repair) keep working.
export { ensureInternalToken };

/** Persist a stable auth secret so sessions survive restarts. */
function ensureAuthSecret(): string {
  const path = AUTH_SECRET_FILE;
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(OS_DIR, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

export const upCommand = new Command("up")
  .description("Start Openship as a persistent service (boot + auto-restart); --foreground to run attached")
  // No defaults on the port flags ON PURPOSE. A commander default makes the option
  // always "set", which reads downstream as "the operator asked for 4000" — it
  // outranked the ports the install was already configured with (rewriting an
  // install pinned to 4100 back to 4000 on a plain re-run) and made the
  // remembered-port path in resolvePorts dead code. Absent must mean absent; the
  // preference chain in lib/ports.ts supplies 4000/3001 as the last resort.
  .option("--port <port>", "API port to listen on (default: 4000, or the next free port if it's taken)")
  .option("--data-dir <dir>", "Directory for the embedded database")
  .option("--dashboard-port <port>", "Dashboard port (default: 3001, or the next free port if it's taken)")
  .option("--no-ui", "Run the API only — don't download/serve the dashboard")
  .option("--ui-version <tag>", "Dashboard release tag to run (default: this CLI's version)")
  .option("-f, --foreground", "Run attached in this terminal instead of as a background service")
  .option(
    "--dry-run",
    "Preview only: print what `up` would install (method, ports, files, commands, the service definition / compose file) and exit WITHOUT changing this machine",
  )
  .option(
    "--public-url <url>",
    "Serve remotely at this public URL (VPS): binds the dashboard to all interfaces, proxies the API same-origin, and requires login",
  )
  .option(
    "--trust-proxy",
    "Trust the X-Real-IP set by a reverse proxy in front (the proxy MUST overwrite X-Real-IP with the real client IP, e.g. `proxy_set_header X-Real-IP $remote_addr`, and the app port MUST be firewalled so only the proxy can reach it; enables per-client rate limiting)",
  )
  .option(
    "--host <addr>",
    "Bind the dashboard to this interface so an upstream reverse proxy (or another LAN host) can reach it — e.g. 0.0.0.0 or a LAN IP like 192.168.1.50. Default 127.0.0.1. The API stays on loopback (the dashboard proxies to it). A concrete IP auto-trusts that browser origin for login; for 0.0.0.0 or a domain also pass --public-url (or set OPENSHIP_EXTRA_TRUSTED_ORIGINS) so login isn't rejected.",
  )
  .option(
    "--managed-edge",
    "Managed edge: install OpenResty + a free Let's Encrypt cert on this box and route --public-url's domain to the dashboard (no reverse proxy needed)",
  )
  .option("--acme-email <email>", "Contact email for Let's Encrypt certificates (managed edge)")
  .option("--from-source", "Preview: build + run Openship from source (a branch) instead of a published release — runs attached")
  .option("--ref <branch>", "Git branch/tag/sha to build with --from-source (default: main)")
  .option("--source <path>", "Build from an existing local Openship checkout instead of cloning")
  .option("--repo <url>", "Git remote to clone for --from-source (default: oblien/openship)")
  .option("--compose", "Install via Docker Compose using the published images (postgres + redis + api + dashboard + edge on :80/:443). Default when Docker is available on Linux.")
  .option("--bare", "Install as the bare process service (embedded DB, no Docker) instead of Compose")
  .option(
    "--no-host-control",
    "Harden: don't give the control plane a channel to this machine's OS. No host SSH key is generated or mounted, host operations refuse, and this box stops being offered as a deploy target. Recommended when this box only manages REMOTE servers — it loses :80/:443 takeover, the host terminal and host port scans. The Docker socket is still mounted (deployments need it), so this is defense in depth, not isolation.",
  )
  .option("--edge <action>", "Compose mode: how to handle an existing proxy on :80/:443 — 'migrate' (import its sites into Openship's edge), 'takeover' (stop it; its sites stop serving), or 'cancel'. Default: prompt when interactive, else cancel.")
  .option("--non-interactive", "Headless install: after the service starts, create the admin + register the domain from the flags below (no prompts). Alias: --yes.")
  .option("--yes", "Alias for --non-interactive.")
  .option("--admin-name <name>", "Admin display name (headless install)")
  .option("--admin-email <email>", "Admin email — required for a headless install")
  .option("--admin-password <password>", "Admin password (min 8). Prefer the OPENSHIP_ADMIN_PASSWORD env var to keep it out of shell history.")
  .option("--domain-kind <kind>", "Headless install domain: byo | custom | free | none (default: byo if --public-url set, else none)")
  .option("--hostname <host>", "Domain/hostname for --domain-kind byo|custom (or derived from --public-url)")
  .option("--slug <slug>", "Free .opsh.io subdomain for --domain-kind free (box must already be Cloud-connected)")
  .action(async (opts: UpOpts & { yes?: boolean }) => {
    // FIRST, before any branch that can touch the box. Every mode below has side
    // effects on the way to deciding what it would do — the install-method choice
    // alone runs `ensureDocker()`, which on a fresh Linux box installs Docker and
    // enables its daemon (#436). A preview that has to install something to tell
    // you what it would install is not a preview.
    if (opts.dryRun) {
      console.log(renderUpPlan(await planUp({ ...opts, publicUrl: effectivePublicUrl(opts.publicUrl) })));
      return;
    }
    // From-source + foreground are bare-only (attached / dev preview).
    if (opts.fromSource || opts.source) return runFromSource(opts);
    if (opts.foreground) return runForeground(opts);
    const headless = !!(opts.nonInteractive || opts.yes);
    // Install method: Compose is the default when it can actually work (Docker on
    // Linux — the edge container needs host networking); else bare. `planMethod`
    // owns the decision so `--dry-run` predicts the same one.
    //
    // Docker is INSTALLED if missing, the same way the interactive wizard does it
    // (ensureDocker → systemCatalog.installs.docker → get.docker.com). Without
    // this, `openship up` on a fresh Linux box silently degraded to the bare
    // install — a different topology than the docs promise — and `--compose` died
    // on a raw "docker: not found" instead of just installing it.
    //
    // Only ASK about Docker when the answer can change the method: --bare never
    // needs it, and on macOS/Windows the compose default is off regardless.
    const needsDocker = !opts.bare && (Boolean(opts.compose) || process.platform === "linux");
    const dockerUsable = needsDocker ? await ensureDocker() : false;
    const { method } = planMethod(opts, dockerUsable);
    if (method === "compose" && !dockerUsable) {
      // Explicitly asked for compose (the only way to get here): install Docker or
      // fail loudly. Falling back to bare would quietly ignore the flag.
      console.error(
        chalk.red("\n  --compose needs Docker + docker compose, and they couldn't be installed automatically.") +
          chalk.dim(
            "\n  Install Docker (https://docs.docker.com/engine/install/) and re-run, or use --bare.\n",
          ),
      );
      process.exit(1);
    }
    if (method === "compose") {
      const started = await runCompose(opts);
      if (headless) {
        // The compose api container boots with the token from compose/.env (NOT
        // the bare ~/.openship token file) — authenticate the setup calls with it.
        const token = composeInternalToken();
        if (!token) {
          console.warn(
            chalk.yellow(
              "\n  Couldn't read the stack's internal token (compose/.env) — create the admin from the dashboard.\n",
            ),
          );
        } else {
          await runHeadlessProvision(
            opts,
            { port: started.apiPort, dashPort: started.dashPort },
            { token, method: "compose" },
          );
        }
      }
      return;
    }
    const started = await startService(opts);
    if (headless) await runHeadlessProvision(opts, started, { method: "bare" });
  });

/**
 * Headless install (bare service): after `startService` installs + supervises
 * the process, create the admin + register the domain from the flags, so a box
 * can be provisioned end-to-end without a TTY (the args-driven counterpart to the
 * interactive wizard). Secrets come from flags/env and are never logged.
 */
async function runHeadlessProvision(
  opts: UpOpts,
  started: { port: string; dashPort: string },
  extra?: { token?: string; method?: "bare" | "compose" },
): Promise<void> {
  let inputs;
  try {
    inputs = resolveInstallInputs({
      adminName: opts.adminName,
      adminEmail: opts.adminEmail,
      adminPassword: opts.adminPassword,
      domainKind: opts.domainKind,
      hostname: opts.hostname,
      slug: opts.slug,
      publicUrl: opts.publicUrl,
      acmeEmail: opts.acmeEmail,
      edge: opts.edge,
    });
  } catch (err) {
    if (err instanceof HeadlessInputError) {
      console.error(chalk.red(`\n  ${err.message}\n`));
      process.exit(1);
    }
    throw err;
  }

  try {
    const result = await headlessProvision({
      port: started.port,
      dashPort: started.dashPort,
      inputs,
      token: extra?.token,
      method: extra?.method,
      onLog: (m) => console.log(chalk.dim(`  ${m}`)),
    });
    console.log(chalk.green(`\n  ✓ Openship provisioned${result.liveUrl ? `: ${result.liveUrl}` : "."}`));
    for (const w of result.warnings) console.warn(chalk.yellow(`  ⚠ ${w}`));
  } catch (err) {
    console.error(chalk.red(`\n  Headless provisioning failed: ${(err as Error).message}\n`));
    process.exit(1);
  }
}

/**
 * `openship up` (Docker Compose): bring up the published images as a stack
 * (postgres + redis + api + dashboard + the OpenResty edge on :80/:443). The
 * heavier, production-shaped profile — Postgres/Redis instead of the bare
 * embedded PGlite. Managed via `docker compose` (openship stop/update/status).
 */
async function runCompose(opts: UpOpts & { yes?: boolean }): Promise<{ apiPort: string; dashPort: string }> {
  const headless = !!(opts.nonInteractive || opts.yes);
  if (!hasDockerCompose()) {
    console.error(
      chalk.red("\n  Docker + `docker compose` are required for the Compose install.\n") +
        chalk.dim("  Install Docker, or run `openship up --bare` for the process mode.\n"),
    );
    process.exit(1);
  }

  // --edge validation (before any side effects).
  if (opts.edge && !EDGE_ACTIONS.includes(opts.edge as EdgeAction)) {
    console.error(
      chalk.red(`\n  Invalid --edge value: ${opts.edge}`) +
        chalk.dim(`\n  Expected one of: ${EDGE_ACTIONS.join(", ")}\n`),
    );
    process.exit(1);
  }

  // Edge preflight: the host-net edge container binds :80/:443 at `up` time, so
  // if a foreign proxy holds them we detect + (on consent) migrate/stop it on the
  // HOST first, reusing the native pipe (lib/edge-preflight.ts). The core delegates
  // this to `openship up` in docker-edge mode (apps/api/.../self-edge.ts).
  // Resolved here rather than after the preflight: the prefetch below writes the
  // same `.env` `composeUp` will, and both need the effective public URL.
  const publicUrl = effectivePublicUrl(opts.publicUrl);

  // No permanent port here either: the stack PUBLISHES the api + dashboard ports on
  // the host, so an occupied 4000/3001 isn't a degraded install — it's a
  // `bind: address already in use` that fails the whole `up`. Resolve once, before
  // the prefetch writes `.env`, and pass the same values to both steps so the
  // prefetched config and the started stack can't disagree.
  const ports = await resolveComposePorts({ api: opts.port, dashboard: opts.dashboardPort });
  const apiPort = String(ports.api);
  const dashboardPort = String(ports.dashboard);
  // A moved dashboard port silently invalidates any trusted origin that named the
  // old one, so the notice checks the install's configured origins too.
  const portNotice = portMoveNotice(ports, [...composeTrustedOriginUrls(), publicUrl]);
  if (portNotice.length) {
    console.log("\n" + portNotice.map((l) => chalk.yellow(`  ${l}`)).join("\n"));
  }

  // Fetch the images BEFORE the preflight can stop anyone's proxy. A takeover that
  // pulls afterwards keeps the box dark for the whole download, and a pull that
  // fails takes their sites down for a problem we could have hit while they were
  // still serving. See composePrefetch.
  const prefetch = ora(
    sourceBuildDir() ? "Building images before touching :80/:443…" : "Pulling images before touching :80/:443…",
  ).start();
  const fetched = composePrefetch({
    apiPort,
    dashboardPort,
    publicUrl,
    trustProxy: opts.trustProxy,
    noHostControl: opts.hostControl === false ? true : undefined,
  });
  if (!fetched) {
    prefetch.fail("Couldn't fetch the stack's images — nothing was changed on this box.");
    console.error(
      chalk.dim("\n  Your current proxy is untouched and still serving. Fix the pull/build error above and re-run.\n"),
    );
    process.exit(1);
  }
  prefetch.succeed("Images ready — nothing on :80/:443 has changed yet.");

  let edgePlan;
  try {
    edgePlan = await planAndApplyHostEdge({ edge: opts.edge as EdgeAction | undefined });
  } catch (e) {
    console.error(
      chalk.red(`\n  Edge preflight failed: ${(e as Error).message}\n`) +
        chalk.dim("  Re-run, or pass --edge=cancel to skip taking over :80/:443.\n"),
    );
    process.exit(1);
  }
  if (!edgePlan.proceed) {
    // `blockedBy` = the handover itself failed (ports never came free), which is a
    // different thing from the operator choosing to keep their proxy — and telling
    // them "left it running, re-run when ready" would send them in a loop.
    console.log(
      edgePlan.blockedBy
        ? chalk.red(`\n  Can't take over the edge: ${edgePlan.blockedBy}.\n`) +
            chalk.dim("  Find what else is bound to those ports (`ss -ltnp | grep -E ':80|:443'`), then re-run.\n")
        : chalk.yellow("\n  Left the existing proxy on :80/:443 running — not starting the stack.\n") +
            chalk.dim("  Re-run and choose migrate / take-over (or pass --edge=migrate|takeover) when ready.\n"),
    );
    process.exit(1);
  }

  const fromSource = sourceBuildDir();
  const spinner = ora(
    fromSource
      ? `Building Openship from ${fromSource} and starting the stack…`
      : "Starting Openship via Docker Compose…",
  ).start();
  const res = await composeUp({
    // Prefetched above, before the preflight stopped anything.
    alreadyFetched: true,
    apiPort,
    dashboardPort,
    publicUrl,
    trustProxy: opts.trustProxy,
    // commander maps `--no-host-control` to hostControl === false. `undefined` when
    // the flag is absent, so a plain re-run keeps the install's original choice
    // instead of silently re-granting host control (see resolveEnvConfig).
    noHostControl: opts.hostControl === false ? true : undefined,
  });
  if (!res.ok) {
    spinner.fail("docker compose failed to start the stack");
    // The preflight stopped AND disabled the operator's proxy to free 80/443. The
    // stack isn't coming up, so put it back — never leave the box dark.
    const restored = edgePlan.action ? await rollbackHostEdge() : false;
    console.error(
      chalk.dim("\n  Check `docker compose -f ~/.openship/compose/docker-compose.yml logs`.\n") +
        (restored
          ? chalk.yellow("  Restored the previous proxy on :80/:443 — your sites are serving again.\n")
          : chalk.dim("  If ports 80/443 are held by another proxy, re-run — the preflight will offer to migrate or take over.\n")),
    );
    process.exit(1);
  }
  spinner.succeed("Openship is running via Docker Compose.");

  // If we stopped the operator's proxy to free :80/:443, OUR edge now owes them a
  // working one. `compose up -d` succeeds as soon as the container is CREATED, so a
  // crash-looping edge gets this far reading as success — with their proxy stopped
  // and every hostname on the box dark.
  //
  // Asks `edgeIsBroken`, not "is it serving": this branch STOPS our edge and restores
  // theirs, so it must only fire on an unambiguous failure. An earlier version probed
  // HTTP inside the container, got a false negative on a box serving live traffic, and
  // reported it as dark — the guard became the outage.
  //
  // The takeover journal is deliberately left open: it is the record of what to
  // restart, and `completeHostEdge()` below (not reached) is what discards it.
  if (edgePlan.action && (await edgeIsBroken(new LocalExecutor()))) {
    const reason = await edgeCrashReason(new LocalExecutor());
    console.error(
      chalk.red(`\n  Openship's edge container is not running${reason ? ` — ${reason}` : "."}`),
    );
    const restored = await rollbackHostEdge();
    console.error(
      restored
        ? chalk.yellow(
            `  Your previous proxy has been restarted — the box is serving again, on it.\n` +
              `  Nothing was migrated. Fix the cause above, then re-run \`openship up\`.\n`,
          )
        : chalk.red(
            `  AND your previous proxy could NOT be restarted automatically — the box is\n` +
              `  serving nothing right now. Start it by hand:\n` +
              `    docker stop openship-edge && sudo systemctl enable --now nginx\n`,
          ),
    );
    process.exit(1);
  }

  // Migrate: the container edge is up now, so re-register the foreign proxy's
  // sites into it. The api drives the DockerEdgeExecutor (the host CLI can't), so
  // we hand it the parsed sites + host-read cert PEMs.
  //
  // NOT best-effort: we already stopped the operator's proxy, so an import that
  // registers nothing means their hostnames are dark. Keep the takeover journal
  // OPEN in that case — it is the only record of how to restart their proxy
  // (unit + wasEnabled), and completing it throws that away. `importMigratedSites`
  // has already printed the failure and the restore command.
  let importedOk = true;
  if (edgePlan.action === "migrate" && edgePlan.sites?.length) {
    const outcome = await importMigratedSites(
      res.apiPort,
      edgePlan.sites,
      edgePlan.certPems,
      edgePlan.staticRootOverrides,
    );
    importedOk = outcome.registered.length > 0;
    // Don't re-offer a stopped proxy's sites on the next run once they're in.
    if (importedOk) markStoppedProxyImported();
  }
  // Edge is serving — close the takeover journal so the next run's recovery
  // doesn't mistake it for an interrupted one and restart the old proxy.
  if (edgePlan.action && importedOk) await completeHostEdge();

  const dashboardUrl = publicUrl ?? `http://localhost:${res.dashPort}`;
  console.log(
    chalk.dim(`  Dashboard: ${dashboardUrl}  (login required)\n`) +
      chalk.dim("  Images:    api + dashboard + edge (OpenResty on :80/:443)\n") +
      chalk.dim("  Manage:    openship stop · openship update · openship status\n") +
      // In headless mode the admin is bootstrapped below — don't tell the user to do it by hand.
      (headless ? "" : chalk.dim("  Create an admin: open the dashboard and register the first account.\n")),
  );
  return { apiPort: res.apiPort, dashPort: res.dashPort };
}

/**
 * `openship up --from-source`: build a branch (or a local checkout) from source
 * and run it attached — the remote sibling of `bun dev`. Reuses runForeground
 * for ALL env / port / public-url / managed-edge wiring; only the API entry
 * (bun-run raw TS) and the dashboard dir (local build) differ.
 */
async function runFromSource(opts: UpOpts): Promise<void> {
  console.log(chalk.cyan("\n  Building Openship from source (preview mode)…"));
  console.log(
    chalk.dim("  Unverified dev build — for previewing a branch, not production self-hosting.\n"),
  );
  let src: FromSourceRun;
  try {
    src = await prepareFromSource({ ref: opts.ref, source: opts.source, repo: opts.repo });
  } catch (e) {
    console.error(
      chalk.red(`\n  Build from source failed: ${(e as Error).message}\n`) +
        chalk.dim("  Small boxes can OOM on the dashboard build — build on a bigger machine and pass --source, or use a published release.\n"),
    );
    process.exit(1);
  }
  console.log(chalk.green(`\n  Built ${src.ref} (${src.sha}). Starting…\n`));
  await runForeground(opts, src);
}

/**
 * Default `openship up`: install + start Openship as a persistent service that
 * auto-restarts on crash and starts on boot, running until `openship stop`.
 */
export async function startService(
  opts: UpOpts,
  runOpts: { quiet?: boolean } = {},
): Promise<{ port: string; dashPort: string; publicUrl?: string }> {
  const publicUrl = effectivePublicUrl(opts.publicUrl);

  // NOTE: no `--dry-run` branch here. The preview is built + printed by the `up`
  // action before it reaches any install path (lib/up-plan.ts), because deciding
  // WHICH path to preview used to install Docker on the way (#436).

  // No permanent port: switch off any occupied default / flag / remembered port
  // BEFORE writing the service unit, so the chosen ports are baked into its args.
  const resolved = await resolvePorts({
    api: opts.port ? Number(opts.port) : undefined,
    dashboard: opts.dashboardPort ? Number(opts.dashboardPort) : undefined,
  });
  const port = String(resolved.api);
  const dashPort = String(resolved.dashboard);

  const flags = {
    port,
    dataDir: opts.dataDir,
    dashboardPort: dashPort,
    ui: opts.ui,
    uiVersion: opts.uiVersion,
    publicUrl,
    trustProxy: opts.trustProxy || opts.managedEdge, // managed edge = OpenResty sets XFF
    host: opts.host,
    managedEdge: opts.managedEdge,
    acmeEmail: opts.acmeEmail,
  };
  try {
    const res = installAndStart(flags);
    // The wizard renders its own summary via clack — stay silent for it.
    if (!runOpts.quiet) {
      // Same trap as the compose path: a public URL pinned to the port we just
      // moved off is an origin the API will reject every login from.
      const portNotice = portMoveNotice(resolved, [publicUrl]);
      if (portNotice.length) {
        console.log("\n" + portNotice.map((l) => chalk.yellow(`  ${l}`)).join("\n"));
      }
      const dashboardLine = publicUrl
        ? chalk.dim(`  Dashboard: ${publicUrl}  (login required)\n`)
        : chalk.dim(`  Dashboard: http://localhost:${dashPort}  (login required)\n`);
      console.log(
        chalk.green("\n  ✔ Openship is running as a service.\n") +
          (opts.ui !== false ? dashboardLine : "") +
          (publicUrl
            ? chalk.dim("  API is proxied through the dashboard (not exposed). Point your reverse proxy / DNS at the dashboard port.\n")
            : chalk.dim(`  API:       http://localhost:${port}/api\n`)) +
          chalk.dim(`  ${res.detail}\n`) +
          chalk.dim("  Starts on boot and auto-restarts. Stop with `openship stop`.\n"),
      );
    }
    return { port, dashPort, publicUrl };
  } catch (e) {
    if (runOpts.quiet) throw e; // let the wizard present the failure
    console.error(
      chalk.red(`\n  Couldn't install the service: ${(e as Error).message}\n`) +
        chalk.dim("  Run `openship up --foreground` to run it attached instead.\n"),
    );
    process.exit(1);
  }
}

/** Run the API + dashboard attached to this terminal (also what the service runs).
 *  `source` (set by --from-source) swaps the API entry to a bun-run of the built
 *  dist and points the dashboard at the local build; everything else is shared. */
async function runForeground(opts: UpOpts, source?: FromSourceRun): Promise<void> {
    // API launch: from-source runs the built dist's raw TS via bun; the normal
    // path runs the CLI-bundled server with the current runtime (node/bun).
    let apiCmd = process.execPath;
    let apiArgs: string[];
    let apiCwd: string | undefined;
    if (source) {
      apiCmd = "bun";
      apiArgs = ["run", "src/index.ts"];
      apiCwd = source.apiDir;
    } else {
      const serverEntry = join(SERVER_DIR, "index.js");
      if (!existsSync(serverEntry)) {
        console.error(
          chalk.red("\n  Bundled server not found in this install.") +
            chalk.dim("\n  Reinstall with `openship update` (or `npm i -g openship`).\n"),
        );
        process.exit(1);
      }
      apiArgs = [serverEntry];
    }

    // Same dynamic allocation as the service installer: prefer the flag /
    // remembered / default port, but switch to a free one if it's occupied.
    const resolved = await resolvePorts({
      api: opts.port ? Number(opts.port) : undefined,
      dashboard: opts.dashboardPort ? Number(opts.dashboardPort) : undefined,
    });
    const port = String(resolved.api);
    const dashPort = String(resolved.dashboard);
    const publicUrl = effectivePublicUrl(opts.publicUrl);
    const managedEdge = Boolean(opts.managedEdge && publicUrl);
    const dataDir: string = opts.dataDir || DATA_DIR;
    mkdirSync(dataDir, { recursive: true });

    // Instance log: tee the API + dashboard child output to one file so the
    // control-plane self-app can serve it back through the normal deployment
    // logs API (see deployment.service getDeploymentLogs adopt branch). Fresh
    // per run ("w") to bound size; the current run's logs answer "is it healthy".
    mkdirSync(LOG_DIR, { recursive: true });
    const instanceLogPath = join(LOG_DIR, "instance.log");
    const instanceLog = createWriteStream(instanceLogPath, { flags: "w" });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: port,
      NODE_ENV: "production",
      // BARE, not "desktop". This box is a server-host: openship runs ON it and it
      // is itself a deploy target. Claiming "desktop" (once done here just to get
      // the in-process job runner) made the API report `isServerHost: false`
      // (health.routes.ts), so `registerSelfServerReconcile` — gated on
      // modes:["selfhosted"] — never ran, "This Server" was never registered, and
      // the deploy wizard offered Openship Cloud as the only target on a box the
      // operator had just installed on purpose.
      //
      // It also mislabelled the security posture: DEPLOY_MODE=desktop relaxes the
      // zero-auth gate and makes INTERNAL_TOKEN optional. "desktop" belongs to
      // Electron alone (apps/desktop/src/main/services.ts:361) — the only launcher
      // that is genuinely a single-user loopback app.
      //
      // The job runner is unaffected: it picks BullMQ vs in-process by REDIS
      // REACHABILITY (app.ts:238), and OPENSHIP_JOB_RUNNER below already pins it.
      DEPLOY_MODE: "bare",
      OPENSHIP_TARGET: "local",
      OPENSHIP_JOB_RUNNER: "in-process",
      PGLITE_DATA_DIR: dataDir,
      BETTER_AUTH_SECRET: ensureAuthSecret(),
    };
    // Bundled server relocates its migrations + pglite assets next to the entry;
    // from-source resolves them from the dist's workspace layout, so leave unset.
    if (!source) {
      env.OPENSHIP_MIGRATIONS_DIR = join(SERVER_DIR, "migrations");
      env.OPENSHIP_PGLITE_ASSETS_DIR = join(SERVER_DIR, "pglite");
      // Pin the mail-server install source to the staged engine tree. The
      // bundled server has no monorepo, so mail.service.ts's cwd-relative
      // default (../../apps/email/engine) would miss and "Transfer iRedMail
      // Engine" would fail with tar: could not chdir. from-source runs from the
      // clone (apiCwd=apiDir), where the default resolves — so leave it unset.
      const engineDir = join(SERVER_DIR, "engine");
      if (existsSync(engineDir)) env.MAIL_SERVER_ENGINE_DIR = engineDir;
    }
    // CLI-managed instances ALWAYS require login (zero-auth is desktop-only).
    // The admin is created by `openship` setup via the internal-token-gated
    // bootstrap endpoint; both processes share this token file.
    env.OPENSHIP_REQUIRE_AUTH = "true";
    env.INTERNAL_TOKEN = ensureInternalToken();
    // DEPLOY_MODE is "desktop" here (in-process job runner), and the server no
    // longer INFERS the auth mode from it — it exits at boot unless the launcher
    // DECLARES OPENSHIP_AUTH_MODE (see apps/api/src/config/env.ts). Declare
    // "local": a CLI-managed box logs in with the bootstrap-created admin, never
    // zero-auth (that is desktop-app-only). Honor an explicit operator override.
    if (!env.OPENSHIP_AUTH_MODE) env.OPENSHIP_AUTH_MODE = "local";
    // The API ALWAYS binds loopback under the CLI — reachable only by the setup
    // wizard and the dashboard proxy on this same box, never exposed on
    // 0.0.0.0. Only the dashboard is ever public, and only in --public-url mode.
    env.OPENSHIP_API_HOST = "127.0.0.1";
    // Tell the API the live dashboard port (dynamic) + where the instance log is,
    // so the self-app boot reconcile syncs the right port and the deployment logs
    // API can tail this run's logs. Set in EVERY mode (not just managed edge).
    env.OPENSHIP_DASHBOARD_PORT = dashPort;
    env.OPENSHIP_INSTANCE_LOG = instanceLogPath;
    delete env.OPENSHIP_ALLOW_ZERO_AUTH;
    if (publicUrl) {
      // Serve the dashboard publicly; it proxies to the loopback API above.
      env.OPENSHIP_PUBLIC_URL = publicUrl;
    } else if (opts.host && !/^(0\.0\.0\.0|127\.|::1?$|localhost$)/i.test(opts.host.trim())) {
      // --host bound to a concrete LAN IP (no public URL): trust the exact origin
      // the browser will use, or originGuard 403s the login POST. For 0.0.0.0 or a
      // domain we can't infer the origin — the user passes --public-url instead.
      env.OPENSHIP_EXTRA_TRUSTED_ORIGINS = `http://${opts.host.trim()}:${dashPort}`;
    }
    // Only trust the forwarded client IP (X-Real-IP) when an operator confirms a
    // real proxy is in front that OVERWRITES it — otherwise a client that can
    // reach the app port directly could forge X-Real-IP (see client-ip).
    if (opts.trustProxy || managedEdge) env.TRUST_PROXY = "true";
    // Managed edge: the API boot hook (self-edge) installs OpenResty + a free
    // Let's Encrypt cert on this box and routes the public hostname → the
    // loopback dashboard. OpenResty terminates TLS and sets XFF (trusted above).
    if (managedEdge) {
      env.OPENSHIP_MANAGED_EDGE = "true";
      env.OPENSHIP_DASHBOARD_PORT = dashPort;
      if (opts.acmeEmail) env.OPENSHIP_ACME_EMAIL = opts.acmeEmail;
    }
    delete env.DATABASE_URL;
    delete env.POSTGRES_URL;

    const spinner = ora(`Starting Openship on http://localhost:${port} …`).start();
    // `detached` puts the child in its OWN process group so we can reap the
    // whole subtree (the API/dashboard may fork workers) with one group signal,
    // and so an orphan can be found + swept by `openship stop`. NOT unref'd — the
    // parent still owns their lifecycle.
    const child = spawn(apiCmd, apiArgs, {
      cwd: apiCwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });

    // Persistent tee → instance.log (independent of the buffer↔passthrough
    // switch below, so the file always captures the full API output).
    child.stdout.on("data", (d) => instanceLog.write(d));
    child.stderr.on("data", (d) => instanceLog.write(d));

    // Buffer output until healthy; on early exit, surface the tail.
    let buffered = "";
    const buffer = (d: Buffer) => {
      buffered += d.toString();
    };
    child.stdout.on("data", buffer);
    child.stderr.on("data", buffer);
    child.on("exit", (code) => {
      if (code && code !== 0) {
        spinner.fail(`Openship server exited (code ${code})`);
        process.stderr.write(buffered.slice(-2000));
        process.exit(code);
      }
    });

    const healthUrl = `http://127.0.0.1:${port}/api/health`;
    let healthy = false;
    for (let i = 0; i < 60 && child.exitCode === null; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(2000) });
        if (res.ok) {
          healthy = true;
          break;
        }
      } catch {
        // not up yet
      }
    }

    if (!healthy) {
      spinner.fail("Openship did not become healthy in time");
      process.stderr.write(buffered.slice(-2000));
      child.kill("SIGTERM");
      process.exit(1);
    }

    spinner.succeed(`Openship API running at http://localhost:${port}`);

    // Track every child so Ctrl-C / a fatal exit / `openship stop` tears them all
    // down together. The API + dashboard hold keep-alive sockets to EACH OTHER,
    // so SIGTERM alone can hang their graceful shutdown (mutual wait) — we MUST
    // escalate to SIGKILL, and the parent must stay alive to deliver it, then
    // exit. A prior version scheduled an UNREF'd SIGKILL and never exited, so
    // launchd force-killed the parent first and the children were orphaned onto
    // the port (`openship stop` "succeeded" but :4000 stayed held).
    const children = [child];
    // Kill the child's whole PROCESS GROUP (negative pid) so any workers it
    // forked die too — a plain child.kill() would leave grandchildren holding
    // the port. Falls back to a direct kill on Windows / when pid is unknown.
    const killTree = (c: typeof child, sig: NodeJS.Signals) => {
      try {
        if (c.pid && process.platform !== "win32") process.kill(-c.pid, sig);
        else c.kill(sig);
      } catch { /* already gone */ }
    };
    let stopping = false;
    const stopAll = (exitCode = 0) => {
      if (stopping) return; // re-entrancy guard (signal + child-exit can race)
      stopping = true;
      try { instanceLog.end(); } catch { /* noop */ }
      for (const c of children) killTree(c, "SIGTERM");
      // Ref'd (NOT unref'd) so the loop stays alive to force-kill, then exit.
      // 1.5s comfortably beats launchd/systemd's own force-kill timeout.
      setTimeout(() => {
        for (const c of children) killTree(c, "SIGKILL");
        process.exit(exitCode);
      }, 1500);
    };

    // Dashboard (unless --no-ui): lazy-downloaded from GitHub releases, then run
    // alongside the API. A UI failure is non-fatal — the API keeps serving.
    let dashboardUrl: string | null = null;
    if (opts.ui !== false) {
      // From-source: use the locally-built standalone (ensureDashboard's
      // OPENSHIP_DASHBOARD_DIR override) instead of downloading a release asset.
      if (source) process.env.OPENSHIP_DASHBOARD_DIR = source.dashboardDir;
      const uiSpinner = ora("Preparing the dashboard…").start();
      try {
        const bundle = await ensureDashboard({
          tag: source ? "local" : opts.uiVersion || `v${__CLI_VERSION__}`,
          onProgress: (received, total) => {
            if (total) {
              uiSpinner.text = `Downloading dashboard… ${Math.round((received / total) * 100)}%`;
            }
          },
        });
        uiSpinner.text = "Starting the dashboard…";
        const dash = spawn(process.execPath, [bundle.entry], {
          cwd: bundle.cwd,
          detached: process.platform !== "win32",
          env: {
            ...process.env,
            NODE_ENV: "production",
            OPENSHIP_TARGET: "local",
            PORT: dashPort,
            // Reachable remotely when public; loopback-only otherwise. Under
            // managed edge the local OpenResty fronts the dashboard, so it stays
            // on loopback even though there's a public URL.
            HOSTNAME: opts.host?.trim() || (publicUrl && !managedEdge ? "0.0.0.0" : "127.0.0.1"),
            // The dashboard's same-origin proxy (NEXT_PUBLIC_API_PROXY, baked
            // into the release build) forwards /api/proxy/* to this address, so
            // the browser never needs to know where the API lives. Set in every
            // mode; loopback because the dashboard runs on the same box.
            INTERNAL_API_URL: `http://127.0.0.1:${port}`,
            // ALWAYS tell the dashboard the real loopback API origin. The API port
            // is dynamic, so a browser opened on THIS box must learn it via
            // window.__OPENSHIP_API_ORIGIN__ (layout.tsx) — otherwise it falls back
            // to the static default :4000 and every call 404s. Use `localhost` (NOT
            // 127.0.0.1) to MATCH the host the dashboard is opened on — a host-only
            // SameSite session cookie set on 127.0.0.1 is never sent to localhost
            // (they're different sites to a browser), which is the login-reload loop.
            // Older dashboards use this origin verbatim; newer ones align it anyway.
            // `localhost` still reaches the 127.0.0.1-bound API. In proxy mode this
            // is just a fallback (sameOriginProxyOrigin wins for remote browsers).
            OPENSHIP_LOCAL_API_URL: `http://localhost:${port}`,
            ...(publicUrl ? { OPENSHIP_PUBLIC_URL: publicUrl } : {}),
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(dash);
        dash.stdout.on("data", (d) => instanceLog.write(d));
        dash.stderr.on("data", (d) => instanceLog.write(d));
        let dashBuf = "";
        const onDash = (d: Buffer) => {
          dashBuf += d.toString();
        };
        dash.stdout.on("data", onDash);
        dash.stderr.on("data", onDash);

        let dashUp = false;
        for (let i = 0; i < 45 && dash.exitCode === null; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const res = await fetch(`http://127.0.0.1:${dashPort}`, { signal: AbortSignal.timeout(2000) });
            if (res.status < 500) {
              dashUp = true;
              break;
            }
          } catch {
            /* not up yet */
          }
        }
        if (dashUp) {
          dashboardUrl = publicUrl ?? `http://localhost:${dashPort}`;
          uiSpinner.succeed(`Dashboard running at ${dashboardUrl}`);
          dash.stdout.off("data", onDash);
          dash.stderr.off("data", onDash);
          dash.stdout.on("data", (d) => process.stdout.write(d));
          dash.stderr.on("data", (d) => process.stderr.write(d));
        } else {
          uiSpinner.warn("Dashboard didn't come up in time — continuing with the API only.");
          process.stderr.write(dashBuf.slice(-1000));
        }
      } catch (e) {
        uiSpinner.warn(`Dashboard unavailable: ${(e as Error).message}`);
        console.log(
          chalk.dim(
            "  The API is still running. Retry `openship up`, pass --no-ui, or use `openship install` for the desktop app.\n",
          ),
        );
      }
    }

    if (publicUrl) {
      console.log(
        (dashboardUrl ? chalk.dim(`  Dashboard: ${dashboardUrl}  (login required)\n`) : "") +
          chalk.dim("  API is proxied through the dashboard (bound to loopback, not exposed).\n") +
          chalk.dim(`  Data:      ${dataDir}\n`) +
          (managedEdge
            ? chalk.dim("  Managed edge (OpenResty + Let's Encrypt) fronts this box — point your domain's A record at this server's IP. Stop with Ctrl-C.\n")
            : chalk.dim("  Point your reverse proxy / DNS at the dashboard port. Stop with Ctrl-C.\n")),
      );
    } else {
      console.log(
        chalk.dim(`  API:       http://localhost:${port}/api\n`) +
          (dashboardUrl ? chalk.dim(`  Dashboard: ${dashboardUrl}  (login required)\n`) : "") +
          chalk.dim(`  Data:      ${dataDir}\n`) +
          chalk.dim("  Log in with your admin account (run `openship` to create one). Stop with Ctrl-C.\n"),
      );
    }

    // API: switch from buffering to live passthrough for the rest of the run.
    child.stdout.off("data", buffer);
    child.stderr.off("data", buffer);
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));

    // stopAll owns the exit (it force-kills after a grace, THEN process.exit).
    // Calling process.exit() here would kill that timer and orphan the tree.
    process.on("SIGINT", () => stopAll(0));
    process.on("SIGTERM", () => stopAll(0));
    // If the API dies, bring the dashboard down with it and exit with its code.
    child.on("exit", (code) => stopAll(code ?? 0));
}
