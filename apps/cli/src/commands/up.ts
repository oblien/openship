import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ensureDashboard } from "../lib/dashboard";
import { mergeTrustedOrigin, normalizePublicUrl } from "../lib/public-url";
import { installAndStart, preview } from "../lib/service";

interface UpOpts {
  port?: string;
  dataDir?: string;
  dashboardPort?: string;
  publicUrl?: string;
  ui?: boolean;
  uiVersion?: string;
  foreground?: boolean;
  dryRun?: boolean;
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

export const upCommand = new Command("up")
  .description("Start Openship as a persistent service (boot + auto-restart); --foreground to run attached")
  .option("--port <port>", "API port to listen on", "4000")
  .option("--data-dir <dir>", "Directory for the embedded database")
  .option("--dashboard-port <port>", "Dashboard port", "3001")
  .option("--public-url <url>", "Public dashboard/API origin when running behind a reverse proxy")
  .option("--no-ui", "Run the API only — don't download/serve the dashboard")
  .option("--ui-version <tag>", "Dashboard release tag to run (default: this CLI's version)")
  .option("-f, --foreground", "Run attached in this terminal instead of as a background service")
  .option("--dry-run", "Print the service definition that would be installed, then exit")
  .action(async (opts: UpOpts) => {
    opts.publicUrl = normalizePublicUrl(opts.publicUrl);
    if (opts.foreground) return runForeground(opts);
    startService(opts);
  });

/**
 * Default `openship up`: install + start Openship as a persistent service that
 * auto-restarts on crash and starts on boot, running until `openship stop`.
 */
function startService(opts: UpOpts): void {
  const flags = {
    port: opts.port,
    dataDir: opts.dataDir,
    dashboardPort: opts.dashboardPort,
    publicUrl: opts.publicUrl,
    ui: opts.ui,
    uiVersion: opts.uiVersion,
  };
  if (opts.dryRun) {
    const p = preview(flags);
    console.log(
      chalk.dim(`\n  service manager: ${p.kind}\n  path: ${p.path}\n\n`) + p.content + "\n",
    );
    return;
  }
  try {
    const res = installAndStart(flags);
    const port = String(opts.port || "4000");
    const dashPort = String(opts.dashboardPort || "3001");
    const dashboardUrl = opts.publicUrl || `http://localhost:${dashPort}`;
    console.log(
      chalk.green("\n  ✔ Openship is running as a service.\n") +
        chalk.dim(`  API:       http://localhost:${port}/api\n`) +
        (opts.ui !== false ? chalk.dim(`  Dashboard: ${dashboardUrl}\n`) : "") +
        chalk.dim(`  ${res.detail}\n`) +
        chalk.dim("  Starts on boot and auto-restarts. Stop with `openship stop`.\n"),
    );
  } catch (e) {
    console.error(
      chalk.red(`\n  Couldn't install the service: ${(e as Error).message}\n`) +
        chalk.dim("  Run `openship up --foreground` to run it attached instead.\n"),
    );
    process.exit(1);
  }
}

/** Run the API + dashboard attached to this terminal (also what the service runs). */
async function runForeground(opts: UpOpts): Promise<void> {
    const serverEntry = join(SERVER_DIR, "index.js");
    if (!existsSync(serverEntry)) {
      console.error(
        chalk.red("\n  Bundled server not found in this install.") +
          chalk.dim("\n  Reinstall with `openship update` (or `npm i -g openship`).\n"),
      );
      process.exit(1);
    }

    const port = String(opts.port || "4000");
    const publicUrl = normalizePublicUrl(opts.publicUrl);
    const dataDir: string = opts.dataDir || join(OS_DIR, "data");
    mkdirSync(dataDir, { recursive: true });

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: port,
      NODE_ENV: "production",
      // desktop mode → in-process job runner (no Redis) + loopback zero-auth,
      // so a local single-user box needs no PAT over 127.0.0.1.
      DEPLOY_MODE: "desktop",
      OPENSHIP_TARGET: "local",
      OPENSHIP_JOB_RUNNER: "in-process",
      OPENSHIP_ALLOW_ZERO_AUTH: "true",
      PGLITE_DATA_DIR: dataDir,
      OPENSHIP_MIGRATIONS_DIR: join(SERVER_DIR, "migrations"),
      OPENSHIP_PGLITE_ASSETS_DIR: join(SERVER_DIR, "pglite"),
      BETTER_AUTH_SECRET: ensureAuthSecret(),
      ...(publicUrl
        ? {
            OPENSHIP_LOCAL_DASHBOARD_URL: publicUrl,
            OPENSHIP_EXTRA_TRUSTED_ORIGINS: mergeTrustedOrigin(
              process.env.OPENSHIP_EXTRA_TRUSTED_ORIGINS,
              publicUrl,
            ),
          }
        : {}),
    };
    delete env.DATABASE_URL;
    delete env.POSTGRES_URL;

    const spinner = ora(`Starting Openship on http://localhost:${port} …`).start();
    const child = spawn(process.execPath, [serverEntry], { env, stdio: ["ignore", "pipe", "pipe"] });

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

    // Track every child so Ctrl-C / a fatal exit tears them all down together.
    const children = [child];
    const stopAll = () => {
      for (const c of children) {
        try {
          c.kill("SIGTERM");
        } catch {
          /* already gone */
        }
        setTimeout(() => {
          try {
            c.kill("SIGKILL");
          } catch {
            /* already gone */
          }
        }, 5000).unref?.();
      }
    };

    // Dashboard (unless --no-ui): lazy-downloaded from GitHub releases, then run
    // alongside the API. A UI failure is non-fatal — the API keeps serving.
    let dashboardUrl: string | null = null;
    if (opts.ui !== false) {
      const dashPort = String(opts.dashboardPort || "3001");
      const uiSpinner = ora("Preparing the dashboard…").start();
      try {
        const bundle = await ensureDashboard({
          tag: opts.uiVersion || `v${__CLI_VERSION__}`,
          onProgress: (received, total) => {
            if (total) {
              uiSpinner.text = `Downloading dashboard… ${Math.round((received / total) * 100)}%`;
            }
          },
        });
        uiSpinner.text = "Starting the dashboard…";
        const dash = spawn(process.execPath, [bundle.entry], {
          cwd: bundle.cwd,
          env: {
            ...process.env,
            NODE_ENV: "production",
            OPENSHIP_TARGET: "local",
            PORT: dashPort,
            HOSTNAME: "127.0.0.1",
            // The dashboard reads this (SSR) and mirrors it into the browser as
            // window.__OPENSHIP_API_ORIGIN__ so both target our local API. It
            // does NOT read API_INTERNAL_URL — using that leaves it defaulting
            // to :4000 (possibly a different instance).
            OPENSHIP_LOCAL_API_URL:
              publicUrl || process.env.OPENSHIP_LOCAL_API_URL || `http://127.0.0.1:${port}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(dash);
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
          dashboardUrl = `http://localhost:${dashPort}`;
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

    console.log(
      chalk.dim(`  API:       http://localhost:${port}/api\n`) +
        (dashboardUrl ? chalk.dim(`  Dashboard: ${dashboardUrl}\n`) : "") +
        chalk.dim(`  Data:      ${dataDir}\n`) +
        chalk.dim("  Local access needs no token (loopback). Stop with Ctrl-C.\n"),
    );

    // API: switch from buffering to live passthrough for the rest of the run.
    child.stdout.off("data", buffer);
    child.stderr.off("data", buffer);
    child.stdout.on("data", (d) => process.stdout.write(d));
    child.stderr.on("data", (d) => process.stderr.write(d));

    process.on("SIGINT", stopAll);
    process.on("SIGTERM", stopAll);
    // If the API dies, bring the dashboard down with it and exit.
    child.on("exit", (code) => {
      stopAll();
      process.exit(code ?? 0);
    });
}
