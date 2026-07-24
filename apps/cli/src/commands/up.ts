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
import { installAndStart, preview } from "../lib/service";
import { composeUp, composeIsViableDefault, hasDockerCompose } from "../lib/compose";
import { resolvePorts } from "../lib/ports";
import { prepareFromSource, type FromSourceRun } from "../lib/from-source";

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
const OS_DIR = join(homedir(), ".openship");

/** Persist a stable auth secret so sessions survive restarts. */
function ensureAuthSecret(): string {
  const path = join(OS_DIR, "auth-secret");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(OS_DIR, { recursive: true, mode: 0o700 });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(path, secret, { mode: 0o600 });
  return secret;
}

/**
 * Persist a stable INTERNAL_TOKEN. The API is booted with it (so zero-auth is
 * off), and the `openship` setup wizard reads the SAME file to authenticate its
 * one-shot POST /system/bootstrap-admin. A browser reaching the API through the
 * public proxy has no token, so it can't create the admin.
 */
export function ensureInternalToken(): string {
  const path = join(OS_DIR, "internal-token");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  mkdirSync(OS_DIR, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

export const upCommand = new Command("up")
  .description("Start Openship as a persistent service (boot + auto-restart); --foreground to run attached")
  .option("--port <port>", "API port to listen on", "4000")
  .option("--data-dir <dir>", "Directory for the embedded database")
  .option("--dashboard-port <port>", "Dashboard port", "3001")
  .option("--no-ui", "Run the API only — don't download/serve the dashboard")
  .option("--ui-version <tag>", "Dashboard release tag to run (default: this CLI's version)")
  .option("-f, --foreground", "Run attached in this terminal instead of as a background service")
  .option("--dry-run", "Print the service definition that would be installed, then exit")
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
  .action(async (opts: UpOpts) => {
    // From-source + foreground are bare-only (attached / dev preview).
    if (opts.fromSource || opts.source) return runFromSource(opts);
    if (opts.foreground) return runForeground(opts);
    // Install method: Compose is the default when it can actually work (Docker
    // present on Linux — the edge container needs host networking); else bare.
    const method = opts.bare ? "bare" : opts.compose ? "compose" : composeIsViableDefault() ? "compose" : "bare";
    if (method === "compose") return runCompose(opts);
    await startService(opts);
  });

/**
 * `openship up` (Docker Compose): bring up the published images as a stack
 * (postgres + redis + api + dashboard + the OpenResty edge on :80/:443). The
 * heavier, production-shaped profile — Postgres/Redis instead of the bare
 * embedded PGlite. Managed via `docker compose` (openship stop/update/status).
 */
async function runCompose(opts: UpOpts): Promise<void> {
  if (!hasDockerCompose()) {
    console.error(
      chalk.red("\n  Docker + `docker compose` are required for the Compose install.\n") +
        chalk.dim("  Install Docker, or run `openship up --bare` for the process mode.\n"),
    );
    process.exit(1);
  }
  const publicUrl = opts.publicUrl ? normalizePublicUrl(opts.publicUrl) : undefined;
  const spinner = ora("Starting Openship via Docker Compose…").start();
  const res = composeUp({
    apiPort: opts.port,
    dashboardPort: opts.dashboardPort,
    publicUrl,
    trustProxy: opts.trustProxy,
  });
  if (!res.ok) {
    spinner.fail("docker compose failed to start the stack");
    console.error(
      chalk.dim("\n  Check `docker compose -f ~/.openship/compose/docker-compose.yml logs`.\n") +
        chalk.dim("  If ports 80/443 are held by another proxy, free them first (the edge binds them).\n"),
    );
    process.exit(1);
  }
  const dashboardUrl = publicUrl ?? `http://localhost:${res.dashPort}`;
  spinner.succeed("Openship is running via Docker Compose.");
  console.log(
    chalk.dim(`  Dashboard: ${dashboardUrl}  (login required)\n`) +
      chalk.dim("  Images:    api + dashboard + edge (OpenResty on :80/:443)\n") +
      chalk.dim("  Manage:    openship stop · openship update · openship status\n") +
      chalk.dim("  Create an admin: open the dashboard and register the first account.\n"),
  );
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
  const publicUrl = opts.publicUrl ? normalizePublicUrl(opts.publicUrl) : undefined;

  // Dry-run only previews the unit file — don't probe or persist ports.
  if (opts.dryRun) {
    const p = preview({
      port: opts.port,
      dataDir: opts.dataDir,
      dashboardPort: opts.dashboardPort,
      ui: opts.ui,
      uiVersion: opts.uiVersion,
      publicUrl,
      trustProxy: opts.trustProxy || opts.managedEdge,
      host: opts.host,
      managedEdge: opts.managedEdge,
      acmeEmail: opts.acmeEmail,
    });
    console.log(
      chalk.dim(`\n  service manager: ${p.kind}\n  path: ${p.path}\n\n`) + p.content + "\n",
    );
    return {
      port: String(opts.port || "4000"),
      dashPort: String(opts.dashboardPort || "3001"),
      publicUrl,
    };
  }

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
      if (resolved.switched.api || resolved.switched.dashboard) {
        console.log(
          chalk.yellow(`\n  A preferred port was busy — using API ${port}, dashboard ${dashPort}.`),
        );
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
    const publicUrl = opts.publicUrl ? normalizePublicUrl(opts.publicUrl) : undefined;
    const managedEdge = Boolean(opts.managedEdge && publicUrl);
    const dataDir: string = opts.dataDir || join(OS_DIR, "data");
    mkdirSync(dataDir, { recursive: true });

    // Instance log: tee the API + dashboard child output to one file so the
    // control-plane self-app can serve it back through the normal deployment
    // logs API (see deployment.service getDeploymentLogs adopt branch). Fresh
    // per run ("w") to bound size; the current run's logs answer "is it healthy".
    const logDir = join(OS_DIR, "logs");
    mkdirSync(logDir, { recursive: true });
    const instanceLogPath = join(logDir, "instance.log");
    const instanceLog = createWriteStream(instanceLogPath, { flags: "w" });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: port,
      NODE_ENV: "production",
      // desktop mode → in-process job runner (no Redis).
      DEPLOY_MODE: "desktop",
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
    }
    // CLI-managed instances ALWAYS require login (zero-auth is desktop-only).
    // The admin is created by `openship` setup via the internal-token-gated
    // bootstrap endpoint; both processes share this token file.
    env.OPENSHIP_REQUIRE_AUTH = "true";
    env.INTERNAL_TOKEN = ensureInternalToken();
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
