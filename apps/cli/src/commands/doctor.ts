/**
 * `openship doctor` — preflight checks before you rely on the CLI.
 *
 * Checks: config file present, an active context with a token, that context's
 * API reachable (GET /api/health via apiRaw, see health.routes.ts), and the
 * Node / Bun runtime versions. Exits non-zero if any check fails so scripts can
 * gate on it.
 */
import { Command } from "commander";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import { apiRaw } from "../lib/api-client";
import { CONFIG_PATH, getActiveContext, getApiUrl, getContext } from "../lib/config";
import { isJsonMode, printJson } from "../lib/output";

interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

function bunVersion(): string | null {
  const embedded = (process.versions as Record<string, string>).bun;
  if (embedded) return embedded;
  try {
    return execFileSync("bun", ["--version"], { encoding: "utf8", timeout: 3000 }).trim();
  } catch {
    return null;
  }
}

function dockerCheck(): { status: "pass" | "warn"; detail: string } {
  try {
    const versionOutput = execFileSync("docker", ["--version"], {
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    const match = versionOutput.match(/Docker version\s+([^\s,]+)/i);
    const ver = match ? match[1] : versionOutput;

    try {
      execFileSync("docker", ["info"], {
        encoding: "utf8",
        timeout: 4000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { status: "pass", detail: `${ver} (running)` };
    } catch {
      return { status: "warn", detail: `${ver} (installed, but daemon is not running)` };
    }
  } catch {
    return {
      status: "warn",
      detail: "not installed (optional for CLI, required for container builds)",
    };
  }
}

export const doctorCommand = new Command("doctor")
  .description("Diagnose the CLI setup (config, active context, runtime)")
  .action(async () => {
    const checks: Check[] = [];

    const hasConfig = existsSync(CONFIG_PATH);
    checks.push({
      name: "config",
      status: hasConfig ? "pass" : "warn",
      detail: hasConfig ? CONFIG_PATH : `not found (${CONFIG_PATH}); run \`openship login\``,
    });

    const context = getActiveContext();
    const apiUrl = getApiUrl();
    const hasToken = Boolean(getContext(context).token);
    checks.push({
      name: "context",
      status: hasToken ? "pass" : "warn",
      detail: hasToken
        ? `${context} (${apiUrl})`
        : `${context} has no token; run \`openship login\``,
    });

    let reachable = false;
    try {
      const res = await apiRaw("/health", { signal: AbortSignal.timeout(6000) });
      reachable = res.ok;
      checks.push({
        name: "api",
        status: res.ok ? "pass" : "fail",
        detail: res.ok ? `reachable (${apiUrl})` : `HTTP ${res.status} from ${apiUrl}`,
      });
    } catch (e) {
      checks.push({ name: "api", status: "fail", detail: `unreachable: ${(e as Error).message}` });
    }

    checks.push({ name: "node", status: "pass", detail: process.versions.node });
    const bun = bunVersion();
    checks.push({
      name: "bun",
      status: bun ? "pass" : "warn",
      detail: bun ?? "not installed (optional)",
    });
    const docker = dockerCheck();
    checks.push({
      name: "docker",
      status: docker.status,
      detail: docker.detail,
    });

    if (isJsonMode()) {
      printJson({ context, apiUrl, reachable, checks });
    } else {
      const glyph = { pass: chalk.green("✓"), warn: chalk.yellow("!"), fail: chalk.red("✗") };
      process.stdout.write(chalk.bold("\n  Openship doctor\n\n"));
      for (const c of checks) {
        process.stdout.write(`  ${glyph[c.status]} ${chalk.bold(c.name.padEnd(8))} ${c.detail}\n`);
      }
      process.stdout.write("\n");
    }

    if (checks.some((c) => c.status === "fail")) process.exit(1);
  });
