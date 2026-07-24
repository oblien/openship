/**
 * `openship status` — what's running on THIS machine + the active context's API.
 *
 * Two parts:
 *   1. Local service — is the `openship up` service installed/running, and on
 *      which resolved ports (they're dynamic; the remembered pair lives in
 *      ~/.openship/ports.json). Always shown, even when the API is down.
 *   2. API — GET /api/health + /api/health/env for the active context (best
 *      effort; a stopped server shows "not reachable", not a hard crash).
 */
import { Command } from "commander";
import chalk from "chalk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { apiRequest, getApiUrl, ApiError } from "../lib/api-client";
import { getActiveContext } from "../lib/config";
import { serviceStatus } from "../lib/service";
import { readInstallMethod, composePs } from "../lib/compose";
import { isJsonMode, printJson } from "../lib/output";

interface Health {
  status?: string;
  timestamp?: string;
}
interface HealthEnv {
  selfHosted?: boolean;
  deployMode?: string;
  authMode?: string;
  teamMode?: string;
  cloudAuthUrl?: string | null;
  cloudApiUrl?: string | null;
  machineName?: string;
  hostDomain?: string;
}

function readPorts(): { api?: number; dashboard?: number } {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".openship", "ports.json"), "utf8"));
  } catch {
    return {};
  }
}

export const statusCommand = new Command("status")
  .description("Show the local Openship service (installed/running, ports) and the active context's API health")
  .action(async () => {
    const context = getActiveContext();
    const apiUrl = getApiUrl();

    // Compose install → the bare service manager reads "not installed", which is
    // misleading. Show the stack (docker compose ps) + a health probe instead.
    if (readInstallMethod() === "compose" && !isJsonMode()) {
      console.log(chalk.bold("\n  Openship status (Docker Compose)\n"));
      composePs();
      try {
        const h = await apiRequest<Health>("/health", { signal: AbortSignal.timeout(8000) });
        console.log(chalk.dim(`\n  API: ${apiUrl} — `) + chalk.green(h.status ?? "ok") + "\n");
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : (e as Error).message;
        console.log(chalk.dim(`\n  API: ${apiUrl} — `) + chalk.red("not reachable") + chalk.dim(`  ${msg}\n`));
      }
      return;
    }

    const svc = serviceStatus();
    const ports = readPorts();

    let health: Health | null = null;
    let envInfo: HealthEnv | null = null;
    let reachable = true;
    let unreachableMsg = "";
    try {
      health = await apiRequest<Health>("/health", { signal: AbortSignal.timeout(8000) });
      envInfo = await apiRequest<HealthEnv>("/health/env", { signal: AbortSignal.timeout(8000) });
    } catch (e) {
      reachable = false;
      unreachableMsg = e instanceof ApiError ? e.message : (e as Error).message;
    }

    if (isJsonMode()) {
      printJson({ context, apiUrl, service: svc, ports, reachable, health, env: envInfo });
      process.exit(reachable ? 0 : 1);
    }

    const row = (label: string, value: unknown) =>
      `  ${chalk.dim(label.padEnd(14))}${value ?? chalk.dim("-")}\n`;

    const serviceState = svc.running
      ? chalk.green("running")
      : svc.installed
        ? chalk.yellow("installed · stopped")
        : chalk.dim("not installed");

    let out =
      chalk.bold("\n  Openship status\n\n") +
      row("Service", serviceState) +
      row("Manager", svc.kind === "unsupported" ? chalk.dim("none") : svc.kind) +
      (ports.api ? row("API port", ports.api) : "") +
      (ports.dashboard ? row("Dashboard port", ports.dashboard) : "") +
      row("Context", context) +
      row("API", apiUrl);

    if (reachable && health && envInfo) {
      out +=
        row("Health", chalk.green(health.status ?? "ok")) +
        row("Mode", envInfo.selfHosted ? "self-hosted" : "cloud") +
        row("Deploy", envInfo.deployMode) +
        row("Auth", envInfo.authMode) +
        row("Team", envInfo.teamMode) +
        (envInfo.hostDomain ? row("Host domain", envInfo.hostDomain) : "") +
        (envInfo.machineName ? row("Machine", envInfo.machineName) : "");
    } else {
      out +=
        row("Health", chalk.red("not reachable")) +
        chalk.dim(`  ${unreachableMsg}\n`) +
        chalk.dim(svc.running ? "  (service is up — it may still be starting)\n" : "  Start it with `openship up`.\n");
    }

    process.stdout.write(out + "\n");
    if (!reachable) process.exit(1);
  });
