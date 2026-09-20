import { exitCommand, rethrowCommandExit } from "../lib/command-exit";
/**
 * `openship service` — manage the services inside a compose stack.
 *
 * A "stack" is a multi-service project: services are mounted under
 * /api/projects/:id/services (service.routes.ts), so every subcommand
 * targets a stack via -p/--project (id, slug, or name) and then a service
 * by name or id within it.
 */

import { Command } from "commander";
import chalk from "chalk";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  normalizeComposeServices,
  OperationError,
  type TCreateServiceBody,
} from "@repo/sdk/client";
import { parseOptionalEnvironmentScope, ValidationError } from "@repo/sdk/client";
import { getShipClient, ApiError, hasShipCredentials } from "../lib/ship-client";
import { isJsonMode, printJson, printTable, ok, err, info } from "../lib/output";

// ─── Shared helpers ──────────────────────────────────────────────────────────

function requireAuth(): void {
  if (!hasShipCredentials()) {
    err("  Not logged in. Run `openship login` first.");
    exitCommand(1);
  }
}

function fail(e: unknown): never {
  rethrowCommandExit(e);
  if (e instanceof ApiError) {
    err(`  ${e.message}` + (e.status ? chalk.dim(` (HTTP ${e.status})`) : ""));
  } else {
    err(`  ${e instanceof Error ? e.message : String(e)}`);
    if (e instanceof ValidationError && e.details) {
      for (const messages of Object.values(e.details))
        for (const message of messages) err(`  ${message}`);
    }
  }
  exitCommand(1);
}

/** Every service subcommand needs a target stack. */
function stackCommand(name: string): Command {
  return new Command(name).requiredOption(
    "-p, --project <id|slug|name>",
    "Stack (project) id, slug, or name",
  );
}

const collect = (val: string, acc: string[]): string[] => {
  acc.push(val);
  return acc;
};

interface ProjectRow {
  id: string;
  name: string;
  slug: string;
}

/** Resolve a stack ref to a project id. proj_ ids are used verbatim (no list scope needed). */
async function resolveProject(ref: string): Promise<string> {
  if (/^proj_/.test(ref)) return ref;
  const matches: ProjectRow[] = [];
  for (let page = 1; ; page++) {
    const result = await getShipClient().projects.list({ page, perPage: 100 });
    for (const p of result.data)
      if (p.id === ref || p.slug === ref || p.name === ref) matches.push(p);
    if (!result.data.length || page * result.perPage >= result.total) break;
  }
  if (matches.length === 0) {
    err(`  No stack matching "${ref}".`);
    exitCommand(1);
  }
  if (matches.length > 1) {
    err(`  "${ref}" is ambiguous (${matches.length} matches) — use the project id (proj_…).`);
    exitCommand(1);
  }
  return matches[0].id;
}

interface ServiceRow {
  id: string;
  name: string;
  kind?: string | null;
  image?: string | null;
  enabled?: boolean;
  exposed?: boolean;
  drift?: unknown;
}

async function listServices(projectId: string): Promise<ServiceRow[]> {
  return getShipClient().services.list(projectId);
}

/** Resolve a service ref (name or svc_ id) to its row within the stack. */
async function resolveService(projectId: string, ref: string): Promise<ServiceRow> {
  if (/^svc_/.test(ref)) return getShipClient().services.get(projectId, ref);
  const services = await listServices(projectId);
  const byId = services.find((s) => s.id === ref);
  if (byId) return byId;
  const byName = services.filter((s) => s.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    err(`  "${ref}" matches ${byName.length} services — pass the service id (svc_…).`);
    exitCommand(1);
  }
  const known = services.map((s) => s.name).join(", ") || "(none)";
  err(`  No service "${ref}" in this stack. Services: ${known}`);
  exitCommand(1);
}

function parsePairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0) {
      err(`  Invalid KEY=VALUE pair: "${p}"`);
      exitCommand(1);
    }
    out[p.slice(0, i)] = p.slice(i + 1);
  }
  return out;
}

/** Gate a destructive action. --yes skips; non-interactive without --yes aborts. */
async function confirmOrExit(yes: boolean | undefined, question: string): Promise<void> {
  if (yes) return;
  if (isJsonMode() || !process.stdin.isTTY) {
    err("  Refusing to proceed without confirmation. Re-run with --yes.");
    exitCommand(1);
  }
  const rl = createInterface({ input, output });
  const answer = (await rl.question(`  ${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    info("  Aborted.");
    exitCommand(0);
  }
}

// ─── list / get ───────────────────────────────────────────────────────────────

const listCmd = stackCommand("list")
  .description("List the services in a stack")
  .action(async (opts) => {
    requireAuth();
    try {
      const projectId = await resolveProject(opts.project);
      const services = await listServices(projectId);
      if (isJsonMode()) {
        printJson(services);
        return;
      }
      printTable(
        services.map((s) => ({
          name: s.name,
          kind: s.kind ?? "compose",
          image: s.image ?? "—",
          enabled: s.enabled ? "yes" : "no",
          exposed: s.exposed ? "yes" : "no",
          drift: s.drift ? chalk.yellow("pending") : "—",
        })),
        ["name", "kind", "image", "enabled", "exposed", "drift"],
      );
    } catch (e) {
      rethrowCommandExit(e);
      fail(e);
    }
  });

const getCmd = stackCommand("get")
  .description("Show one service's configuration")
  .argument("<service>", "Service name or id")
  .action(async (service: string, opts) => {
    requireAuth();
    try {
      const projectId = await resolveProject(opts.project);
      const svc = await resolveService(projectId, service);
      printJson(await getShipClient().services.get(projectId, svc.id));
    } catch (e) {
      rethrowCommandExit(e);
      fail(e);
    }
  });

// ─── create / delete ────────────────────────────────────────────────────────

const createCmd = stackCommand("create")
  .description("Add a service to a stack")
  .argument("<name>", "Service name (unique within the stack)")
  .option("--image <image>", "Container image (e.g. postgres:16)")
  .option("--build <context>", "Build context path (relative to repo root)")
  .option("--dockerfile <path>", "Dockerfile path (relative to build context)")
  .option("--port <mapping>", "Port mapping, e.g. 8080:80 (repeatable)", collect, [])
  .option("--depends-on <service>", "Service this depends on (repeatable)", collect, [])
  .option("--env <KEY=VALUE>", "Compose environment default (repeatable)", collect, [])
  .option("--command <command>", "Override the container command")
  .option("--restart <policy>", "Restart policy: no | always | on-failure | unless-stopped")
  .option("--expose", "Expose the service publicly through managed routing")
  .option("--exposed-port <port>", "Container port to expose publicly")
  .option("--domain <label>", "Free subdomain label (with --expose)")
  .action(async (name: string, opts) => {
    requireAuth();
    try {
      const projectId = await resolveProject(opts.project);
      const body: TCreateServiceBody = { name };
      if (opts.image) body.image = opts.image;
      if (opts.build) body.build = opts.build;
      if (opts.dockerfile) body.dockerfile = opts.dockerfile;
      if (opts.port.length) body.ports = opts.port;
      if (opts.dependsOn.length) body.dependsOn = opts.dependsOn;
      if (opts.env.length) body.environment = parsePairs(opts.env);
      if (opts.command) body.command = opts.command;
      if (opts.restart) body.restart = opts.restart;
      if (opts.expose) {
        body.exposed = true;
        if (opts.exposedPort) body.exposedPort = opts.exposedPort;
        if (opts.domain) {
          body.domain = opts.domain;
          body.domainType = "free";
        }
      }
      const created = await getShipClient().services.create(projectId, body);
      if (isJsonMode()) {
        printJson(created);
        return;
      }
      ok(`  Created service "${created.name}" (${created.id}).`);
    } catch (e) {
      rethrowCommandExit(e);
      fail(e);
    }
  });

const deleteCmd = stackCommand("delete")
  .alias("rm")
  .description("Remove a service from a stack")
  .argument("<service>", "Service name or id")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (service: string, opts) => {
    requireAuth();
    try {
      const projectId = await resolveProject(opts.project);
      const svc = await resolveService(projectId, service);
      await confirmOrExit(opts.yes, `Delete service "${svc.name}"? This tears down its container.`);
      await getShipClient().services.remove(projectId, svc.id);
      ok(`  Deleted service "${svc.name}".`);
    } catch (e) {
      rethrowCommandExit(e);
      fail(e);
    }
  });

// ─── sync ──────────────────────────────────────────────────────────────────

const syncCmd = stackCommand("sync")
  .description(
    "Sync a stack's services from a docker-compose file (services not in the file are removed)",
  )
  .argument("<compose-file>", "Path to docker-compose.yml / compose.yaml")
  .option("-y, --yes", "Skip the confirmation prompt")
  .action(async (composeFile: string, opts) => {
    requireAuth();
    // No YAML dependency in the CLI: let Docker Compose parse + interpolate,
    // then map its normalized JSON to the sync payload.
    const abs = path.resolve(composeFile);
    const proc = spawnSync("docker", ["compose", "-f", abs, "config", "--format", "json"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (proc.error) {
      if ((proc.error as NodeJS.ErrnoException).code === "ENOENT") {
        err("  `docker` not found. `service sync` uses Docker Compose to parse the file.");
      } else {
        err(`  Failed to run docker compose: ${proc.error.message}`);
      }
      exitCommand(1);
    }
    if (proc.status !== 0) {
      err(`  docker compose config failed:\n${(proc.stderr || "").trim()}`);
      exitCommand(1);
    }
    let doc: { services?: Record<string, unknown> };
    try {
      doc = JSON.parse(proc.stdout);
    } catch {
      err("  Could not parse compose output as JSON (needs Docker Compose v2: `docker compose`).");
      exitCommand(1);
    }

    try {
      const services = normalizeComposeServices(doc, path.dirname(abs));
      const projectId = await resolveProject(opts.project);
      info(
        `  Syncing ${services.length} service(s): ${services.map((s) => s.name).join(", ")}\n` +
          "  Services in the stack but not in this file will be removed.",
      );
      await confirmOrExit(opts.yes, "Proceed with the sync?");
      const synced = await getShipClient().services.sync(projectId, { services });
      if (isJsonMode()) {
        printJson(synced);
        return;
      }
      ok(`  Synced ${synced.length} service(s).`);
    } catch (e) {
      rethrowCommandExit(e);
      fail(e);
    }
  });

// ─── start / stop / restart ──────────────────────────────────────────────────

function containerActionCommand(action: "start" | "stop" | "restart"): Command {
  const cmd = stackCommand(action)
    .description(
      action === "restart"
        ? "Bounce a service's container (does NOT apply changed env — use `deploy --refresh` for that)"
        : `${action[0].toUpperCase()}${action.slice(1)} a service's container`,
    )
    .argument("<service>", "Service name or id");
  if (action === "restart") {
    cmd.option("--force", "Bounce even with pending env changes (they will NOT be applied)");
  }
  return cmd.action(async (service: string, opts) => {
    requireAuth();
    // Hoisted so the catch below can name the resolved ids in its guidance —
    // the whole point of the refusal is that it tells you the command to run.
    let serviceId = "";
    try {
      const projectId = await resolveProject(opts.project);
      const svc = await resolveService(projectId, service);
      serviceId = svc.id;
      if (action === "restart")
        await getShipClient().services.restart(projectId, svc.id, { force: !!opts.force });
      else await getShipClient().services[action](projectId, svc.id);
      ok(`  ${action}ed "${svc.name}".`);
    } catch (e) {
      rethrowCommandExit(e);
      // The API refuses a restart that would silently drop pending env changes.
      // Print the drifted keys and the command that DOES apply them, rather than
      // leaving the operator to re-read a one-line error (GH-615).
      const body = e instanceof OperationError ? e.details : undefined;
      if (e instanceof OperationError && e.code === "SERVICE_CONFIG_STALE" && body) {
        const keys = Array.isArray(body.staleEnvKeys) ? (body.staleEnvKeys as string[]) : [];
        err(`  Restart refused: "${body.serviceName ?? service}" has pending environment changes.`);
        if (keys.length > 0) info(`  Pending: ${keys.join(", ")}`);
        info(
          `  Apply them:  openship deploy --refresh --service-ids ${serviceId} -p ${opts.project}`,
        );
        info(`  Bounce anyway (changes NOT applied):  add --force`);
        exitCommand(1);
      }
      fail(e);
    }
  });
}

// ─── containers ──────────────────────────────────────────────────────────────

const containersCmd = stackCommand("containers")
  .description("List the stack's active-deployment containers")
  .action(async (opts) => {
    requireAuth();
    try {
      const projectId = await resolveProject(opts.project);
      const containers = await getShipClient().services.activeContainers(projectId);
      if (isJsonMode()) {
        printJson(containers);
        return;
      }
      printTable(
        containers.map((c) => ({
          service: (c.serviceName as string) ?? "—",
          status: (c.status as string) ?? "—",
          container: c.containerId ? String(c.containerId).slice(0, 12) : "—",
          ip: (c.ip as string) ?? "—",
          port: c.hostPort != null ? String(c.hostPort) : "—",
        })),
        ["service", "status", "container", "ip", "port"],
      );
    } catch (e) {
      rethrowCommandExit(e);
      fail(e);
    }
  });

// ─── drift (accept upstream / keep edits) ─────────────────────────────────────

const driftCmd = new Command("drift").description(
  "Resolve compose drift on a service (upstream compose changed a value you edited)",
);

function driftActionCommand(action: "accept" | "keep"): Command {
  const desc =
    action === "accept"
      ? "Apply the upstream compose values, discarding your edits"
      : "Keep your edits and stop flagging the upstream change";
  return stackCommand(action)
    .description(desc)
    .argument("<service>", "Service name or id")
    .action(async (service: string, opts) => {
      requireAuth();
      try {
        const projectId = await resolveProject(opts.project);
        const svc = await resolveService(projectId, service);
        const updated = await getShipClient().services[
          action === "accept" ? "acceptDrift" : "keepDrift"
        ](projectId, svc.id);
        if (isJsonMode()) {
          printJson(updated);
          return;
        }
        ok(
          action === "accept"
            ? `  Accepted upstream compose changes for "${svc.name}".`
            : `  Kept your edits for "${svc.name}".`,
        );
      } catch (e) {
      rethrowCommandExit(e);
        fail(e);
      }
    });
}

driftCmd.addCommand(driftActionCommand("accept"));
driftCmd.addCommand(driftActionCommand("keep"));

// ─── env (get / set) ──────────────────────────────────────────────────────────

const envCmd = new Command("env").description("Read and write a service's environment variables");

const envGetCmd = stackCommand("get")
  .description("List a service's environment variables (secrets masked)")
  .argument("<service>", "Service name or id")
  .option("-e, --env <environment>", "Environment: production | preview | development")
  .action(async (service: string, opts) => {
    requireAuth();
    try {
      const projectId = await resolveProject(opts.project);
      const svc = await resolveService(projectId, service);
      const vars = await getShipClient().services.listEnvVars(projectId, svc.id, {
        environment: parseOptionalEnvironmentScope(opts.env),
      });
      if (isJsonMode()) {
        printJson(vars);
        return;
      }
      printTable(
        vars.map((v) => ({
          key: v.key as string,
          value: v.value as string,
          environment: (v.environment as string) ?? "—",
          secret: v.isSecret ? "yes" : "no",
        })),
        ["key", "value", "environment", "secret"],
      );
    } catch (e) {
      rethrowCommandExit(e);
      fail(e);
    }
  });

const envSetCmd = stackCommand("set")
  .description("Set a service's environment variables for one environment")
  .argument("<service>", "Service name or id")
  .argument("<pairs...>", "KEY=VALUE pairs")
  .option(
    "-e, --env <environment>",
    "Environment: production | preview | development",
    "production",
  )
  .option("--secret", "Mark the provided variables as secret")
  .option("--replace", "Replace ALL variables for this environment with only the given pairs")
  .action(async (service: string, pairs: string[], opts) => {
    requireAuth();
    try {
      const projectId = await resolveProject(opts.project);
      const svc = await resolveService(projectId, service);
      const environment = parseOptionalEnvironmentScope(opts.env) ?? "production";
      const desired = parsePairs(pairs);
      const isSecret = Boolean(opts.secret);

      // The service env endpoint is a full replace (delete-then-insert for this
      // environment scope), so a partial set must first read the current vars
      // and merge — otherwise unspecified vars would be wiped.
      let vars: { key: string; value: string; isSecret: boolean }[];
      if (opts.replace) {
        vars = Object.entries(desired).map(([key, value]) => ({ key, value, isSecret }));
      } else {
        const existing = await getShipClient().services.listEnvVars(projectId, svc.id, {
          environment,
        });
        // The shared replacement preserves masked ciphertext by source id.
        const merged = new Map<
          string,
          { sourceId?: string; key: string; value: string; isSecret: boolean }
        >();
        for (const v of existing)
          merged.set(v.key, { sourceId: v.id, key: v.key, value: v.value, isSecret: v.isSecret });
        for (const [key, value] of Object.entries(desired)) {
          merged.set(key, { key, value, isSecret });
        }
        vars = [...merged.values()];
      }

      await getShipClient().services.setEnvVars(projectId, svc.id, { environment, vars });
      ok(
        `  Set ${Object.keys(desired).length} variable(s) on "${svc.name}" (${environment}); ` +
          `${vars.length} total now stored.`,
      );
    } catch (e) {
      rethrowCommandExit(e);
      fail(e);
    }
  });

envCmd.addCommand(envGetCmd);
envCmd.addCommand(envSetCmd);

// ─── logs (--follow via SSE) ──────────────────────────────────────────────────

function printLogEntry(entry: { timestamp?: string; message?: string; level?: string }): void {
  const msg = entry.message ?? "";
  if (isJsonMode()) {
    process.stdout.write(JSON.stringify(entry) + "\n");
    return;
  }
  const ts = entry.timestamp ? chalk.dim(entry.timestamp) : "";
  const line =
    entry.level === "error" ? chalk.red(msg) : entry.level === "warn" ? chalk.yellow(msg) : msg;
  process.stdout.write(`${ts ? ts + " " : ""}${line}\n`);
}

const logsCmd = stackCommand("logs")
  .description("Show or stream a service's runtime logs")
  .argument("<service>", "Service name or id")
  .option("-f, --follow", "Stream new log lines as they arrive (SSE)")
  .option("--tail <n>", "Number of lines to show from the end", "200")
  .action(async (service: string, opts) => {
    requireAuth();
    try {
      const projectId = await resolveProject(opts.project);
      const svc = await resolveService(projectId, service);
      const tail = opts.tail ? Number(opts.tail) : undefined;

      if (!opts.follow) {
        const entries = await getShipClient().services.runtimeLogs(projectId, svc.id, { tail });
        if (isJsonMode()) {
          printJson(entries);
          return;
        }
        for (const e of entries) printLogEntry(e);
        return;
      }

      for await (const ev of getShipClient().services.streamLogs(projectId, svc.id, { tail })) {
        if (ev.event === "error") {
          const parsed = safeParse(ev.data);
          throw new ApiError((parsed?.error as string) || "Log stream error", 0, parsed);
        }
        if (ev.event === "log") {
          const parsed = safeParse(ev.data);
          if (parsed)
            printLogEntry(parsed as { timestamp?: string; message?: string; level?: string });
        }
      }
    } catch (e) {
      rethrowCommandExit(e);
      fail(e);
    }
  });

function safeParse(data: string): Record<string, unknown> | null {
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── exec ───────────────────────────────────────────────────────────────────

const execCmd = stackCommand("exec")
  .description("Run a shell command inside a service's isolated container")
  .argument("<service>", "Service name or id")
  .argument("<command>", "Shell command (quote it as one argument)")
  .option("--cwd <path>", "Working directory inside the container")
  .option("--timeout <ms>", "Command timeout in milliseconds", "30000")
  .action(async (service: string, command: string, opts) => {
    requireAuth();
    try {
      const projectId = await resolveProject(opts.project);
      const svc = await resolveService(projectId, service);
      const result = await getShipClient().services.exec(projectId, svc.id, {
        command,
        cwd: opts.cwd,
        timeoutMs: Number(opts.timeout),
      });
      if (isJsonMode()) printJson(result);
      else {
        process.stdout.write(result.output);
        if (result.truncated) info("  Output truncated.");
        if (result.timedOut) err("  Command timed out.");
      }
      process.exitCode = result.timedOut ? 124 : result.exitCode;
    } catch (error) {
      rethrowCommandExit(error);
      fail(error);
    }
  });

// ─── parent command ────────────────────────────────────────────────────────

export const serviceCommand = new Command("service")
  .alias("services")
  .description("Manage the services in a compose stack (a multi-service project)");

serviceCommand.addCommand(listCmd);
serviceCommand.addCommand(getCmd);
serviceCommand.addCommand(createCmd);
serviceCommand.addCommand(deleteCmd);
serviceCommand.addCommand(syncCmd);
serviceCommand.addCommand(containerActionCommand("start"));
serviceCommand.addCommand(containerActionCommand("stop"));
serviceCommand.addCommand(containerActionCommand("restart"));
serviceCommand.addCommand(containersCmd);
serviceCommand.addCommand(driftCmd);
serviceCommand.addCommand(envCmd);
serviceCommand.addCommand(logsCmd);
serviceCommand.addCommand(execCmd);
