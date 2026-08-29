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
  commandToArgv,
  composeBuildIssues,
  composeMountIssues,
  composeMountToSpec,
  composePortToSpec,
  parseComposeNamespace,
  type ComposeAdvanced,
} from "@repo/core";
import { apiRequest, ApiError, paginate } from "../lib/api-client";
import { sseRequest } from "../lib/sse";
import { getToken } from "../lib/config";
import { isJsonMode, printJson, printTable, ok, err, info } from "../lib/output";

// ─── Shared helpers ──────────────────────────────────────────────────────────

function requireAuth(): void {
  if (!getToken()) {
    err("  Not logged in. Run `openship login` first.");
    process.exit(1);
  }
}

function fail(e: unknown): never {
  if (e instanceof ApiError) {
    err(`  ${e.message}` + (e.status ? chalk.dim(` (HTTP ${e.status})`) : ""));
  } else {
    err(`  ${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(1);
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
  for await (const p of paginate<ProjectRow>("/projects")) {
    if (p.id === ref || p.slug === ref || p.name === ref) matches.push(p);
  }
  if (matches.length === 0) {
    err(`  No stack matching "${ref}".`);
    process.exit(1);
  }
  if (matches.length > 1) {
    err(`  "${ref}" is ambiguous (${matches.length} matches) — use the project id (proj_…).`);
    process.exit(1);
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
  const res = await apiRequest<{ services: ServiceRow[] }>(`/projects/${projectId}/services`);
  return res.services ?? [];
}

/** Resolve a service ref (name or svc_ id) to its row within the stack. */
async function resolveService(projectId: string, ref: string): Promise<ServiceRow> {
  const services = await listServices(projectId);
  const byId = services.find((s) => s.id === ref);
  if (byId) return byId;
  const byName = services.filter((s) => s.name === ref);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    err(`  "${ref}" matches ${byName.length} services — pass the service id (svc_…).`);
    process.exit(1);
  }
  const known = services.map((s) => s.name).join(", ") || "(none)";
  err(`  No service "${ref}" in this stack. Services: ${known}`);
  process.exit(1);
}

function parsePairs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i <= 0) {
      err(`  Invalid KEY=VALUE pair: "${p}"`);
      process.exit(1);
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
    process.exit(1);
  }
  const rl = createInterface({ input, output });
  const answer = (await rl.question(`  ${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") {
    info("  Aborted.");
    process.exit(0);
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
      const res = await apiRequest<{ service: unknown }>(
        `/projects/${projectId}/services/${svc.id}`,
      );
      printJson(res.service);
    } catch (e) {
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
      const body: Record<string, unknown> = { name };
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
      const res = await apiRequest<{ service: { id: string; name: string } }>(
        `/projects/${projectId}/services`,
        { method: "POST", body: JSON.stringify(body) },
      );
      if (isJsonMode()) {
        printJson(res.service);
        return;
      }
      ok(`  Created service "${res.service.name}" (${res.service.id}).`);
    } catch (e) {
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
      await apiRequest(`/projects/${projectId}/services/${svc.id}`, { method: "DELETE" });
      ok(`  Deleted service "${svc.name}".`);
    } catch (e) {
      fail(e);
    }
  });

// ─── sync ──────────────────────────────────────────────────────────────────

/** Rewrite an absolute build context (as docker resolves it) back to a repo-relative path. */
function relativizeContext(ctx: string | undefined, baseDir: string): string | undefined {
  if (!ctx) return undefined;
  if (!path.isAbsolute(ctx)) return ctx;
  const rel = path.relative(baseDir, ctx);
  if (rel === "") return ".";
  return rel.startsWith(".") ? rel : `./${rel}`;
}

// `docker compose config` ALWAYS normalizes to long form, so these two are the
// only path a synced port or mount takes — which is why they spelling their own
// fold was so costly: this mapper dropped `read_only`, and every `:ro` in every
// synced compose file became a WRITABLE bind mount of a host directory the author
// had marked read-only. It dropped `host_ip` the same way. Both now go through the
// one shared fold in @repo/core, the same one the API's YAML parser uses (#533).
function mapPorts(ports: unknown): string[] {
  if (!Array.isArray(ports)) return [];
  return ports.map((p) => {
    if (typeof p === "string") return p;
    if (typeof p === "number") return String(p);
    if (p && typeof p === "object") {
      const spec = composePortToSpec(p as Record<string, unknown>);
      if (spec !== undefined) return spec;
    }
    return String(p);
  });
}

function mapVolumes(vols: unknown, name: string, errors: string[]): string[] {
  if (!Array.isArray(vols)) return [];
  return vols.map((v) => {
    if (typeof v === "string") return v;
    if (v && typeof v === "object") {
      // The same mount rules the API import enforces. Without this, a file the
      // wizard refuses (a tmpfs that would become persistent disk, a subpath that
      // would mount the whole volume) synced cleanly through the CLI instead —
      // one policy accepted by one door and rejected by the other.
      for (const issue of composeMountIssues(v as Record<string, unknown>)) {
        if (issue.blocking) errors.push(`  ${name}: ${issue.reason}`);
      }
      const spec = composeMountToSpec(v as Record<string, unknown>);
      if (spec !== undefined) return spec;
    }
    return String(v);
  });
}

function mapEnv(env: unknown): Record<string, string> {
  if (Array.isArray(env)) {
    const out: Record<string, string> = {};
    for (const item of env) {
      if (typeof item !== "string") continue;
      const i = item.indexOf("=");
      if (i > 0) out[item.slice(0, i)] = item.slice(i + 1);
      else out[item] = "";
    }
    return out;
  }
  if (env && typeof env === "object") {
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(env as Record<string, unknown>)) {
      out[k] = val == null ? "" : String(val);
    }
    return out;
  }
  return {};
}

function mapDependsOn(deps: unknown): string[] {
  if (Array.isArray(deps)) return deps.filter((d): d is string => typeof d === "string");
  if (deps && typeof deps === "object") return Object.keys(deps);
  return [];
}

function mapBuildArgs(raw: unknown): Record<string, string | null> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const args: Record<string, string | null> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || value === undefined) args[key] = null;
    else if (["string", "number", "boolean"].includes(typeof value)) {
      args[key] = String(value);
    }
  }
  return Object.keys(args).length > 0 ? args : undefined;
}

/**
 * Shared namespaces for the sync payload, refusing what can't be honored.
 *
 * Returns the rejection reasons alongside the value so `sync` can print them and
 * exit non-zero rather than uploading a service list that quietly omits them —
 * the CLI's half of "error out instead of silently dropping" (#533).
 */
function mapNamespaces(
  name: string,
  d: Record<string, unknown>,
): { advanced: ComposeAdvanced; errors: string[] } {
  const advanced: ComposeAdvanced = {};
  const errors: string[] = [];
  for (const [key, raw, field] of [
    ["networkMode", d.network_mode, "network_mode"],
    ["pidMode", d.pid, "pid"],
  ] as const) {
    const parsed = parseComposeNamespace(raw, field);
    if (!parsed) continue;
    if (parsed.ok) advanced[key] = parsed.value;
    else errors.push(`  ${name}: ${parsed.reason}`);
  }
  return { advanced, errors };
}

export function mapComposeService(
  name: string,
  def: unknown,
  baseDir: string,
  errors: string[],
): Record<string, unknown> {
  const d = (def ?? {}) as Record<string, unknown>;
  const svc: Record<string, unknown> = { name };

  if (typeof d.image === "string") svc.image = d.image;

  const build = d.build;
  // `docker compose config` has already normalized local contexts to absolute
  // paths, so those are safe here (and are relativized back below). Everything
  // else follows the same fail-closed build policy as the API YAML importer:
  // syncing must not silently discard a target, secret/SSH contract, malformed
  // arg, or another build option that can change the produced image.
  for (const issue of composeBuildIssues(build, { allowAbsoluteContext: true })) {
    if (issue.blocking) errors.push(`  ${name}: ${issue.reason}`);
  }
  if (typeof build === "string") {
    svc.build = relativizeContext(build, baseDir);
  } else if (build && typeof build === "object") {
    const b = build as Record<string, unknown>;
    svc.build = relativizeContext(typeof b.context === "string" ? b.context : ".", baseDir);
    if (typeof b.dockerfile === "string") svc.dockerfile = b.dockerfile;
    const buildArgs = mapBuildArgs(b.args);
    if (buildArgs) svc.buildArgs = buildArgs;
  }

  const ports = mapPorts(d.ports);
  if (ports.length) svc.ports = ports;
  const dependsOn = mapDependsOn(d.depends_on);
  if (dependsOn.length) svc.dependsOn = dependsOn;
  const environment = mapEnv(d.environment);
  if (Object.keys(environment).length) svc.environment = environment;
  const volumes = mapVolumes(d.volumes, name, errors);
  if (volumes.length) svc.volumes = volumes;

  // #332: carry structured argv (list verbatim / string shell-split) so the
  // deploy runs the real Cmd, not a `sh -c`-wrapped string that breaks
  // entrypoint+CMD images. `command` string kept for display / legacy.
  const command = d.command as string | string[] | undefined;
  if (command != null) {
    svc.commandArgv = commandToArgv(command);
    svc.command = typeof command === "string" ? command : command.map(String).join(" ");
  }

  if (typeof d.restart === "string") svc.restart = d.restart;

  // Extended keys. The sync endpoint has always accepted `advanced` as an open
  // object; this mapper simply never filled it, so a synced stack lost its shared
  // namespaces the same way it lost read-only mounts.
  const { advanced, errors: namespaceErrors } = mapNamespaces(name, d);
  errors.push(...namespaceErrors);
  // `docker compose config` has already expanded args, including turning `$$`
  // into a literal `$`. An explicit empty marker prevents the API from ever
  // treating that normalized literal as a raw template on a later deploy.
  if (
    build &&
    typeof build === "object" &&
    Object.hasOwn(build as Record<string, unknown>, "args")
  ) {
    advanced.buildArgTemplateKeys = [];
  }
  if (Object.keys(advanced).length > 0) svc.advanced = advanced;

  return svc;
}

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
      process.exit(1);
    }
    if (proc.status !== 0) {
      err(`  docker compose config failed:\n${(proc.stderr || "").trim()}`);
      process.exit(1);
    }
    let doc: { services?: Record<string, unknown> };
    try {
      doc = JSON.parse(proc.stdout);
    } catch {
      err("  Could not parse compose output as JSON (needs Docker Compose v2: `docker compose`).");
      process.exit(1);
    }

    const baseDir = path.dirname(abs);
    const mapErrors: string[] = [];
    const services = Object.entries(doc.services ?? {}).map(([name, def]) =>
      mapComposeService(name, def, baseDir, mapErrors),
    );
    if (services.length === 0) {
      err("  No services found in the compose file.");
      process.exit(1);
    }
    // Refuse rather than upload a list that omits what the file asked for. Syncing
    // anyway is how a compose file's namespace intent used to disappear silently.
    if (mapErrors.length > 0) {
      err(
        `  This compose file declares options Openship can't deploy faithfully:\n${mapErrors.join("\n")}`,
      );
      process.exit(1);
    }

    try {
      const projectId = await resolveProject(opts.project);
      info(
        `  Syncing ${services.length} service(s): ${services.map((s) => s.name).join(", ")}\n` +
          "  Services in the stack but not in this file will be removed.",
      );
      await confirmOrExit(opts.yes, "Proceed with the sync?");
      const res = await apiRequest<{ services: unknown[] }>(
        `/projects/${projectId}/services/sync`,
        { method: "POST", body: JSON.stringify({ services }) },
      );
      if (isJsonMode()) {
        printJson(res.services);
        return;
      }
      ok(`  Synced ${res.services?.length ?? services.length} service(s).`);
    } catch (e) {
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
      const query = action === "restart" && opts.force ? "?force=true" : "";
      await apiRequest(`/projects/${projectId}/services/${svc.id}/${action}${query}`, {
        method: "POST",
      });
      ok(`  ${action}ed "${svc.name}".`);
    } catch (e) {
      // The API refuses a restart that would silently drop pending env changes.
      // Print the drifted keys and the command that DOES apply them, rather than
      // leaving the operator to re-read a one-line error (GH-615).
      const body = e instanceof ApiError ? (e.body as Record<string, unknown> | null) : null;
      if (body?.code === "SERVICE_CONFIG_STALE") {
        const keys = Array.isArray(body.staleEnvKeys) ? (body.staleEnvKeys as string[]) : [];
        err(`  Restart refused: "${body.serviceName ?? service}" has pending environment changes.`);
        if (keys.length > 0) info(`  Pending: ${keys.join(", ")}`);
        info(
          `  Apply them:  openship deploy --refresh --service-ids ${serviceId} -p ${opts.project}`,
        );
        info(`  Bounce anyway (changes NOT applied):  add --force`);
        process.exit(1);
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
      const res = await apiRequest<{ containers: Record<string, unknown>[] }>(
        `/projects/${projectId}/services/containers`,
      );
      const containers = res.containers ?? [];
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
        const res = await apiRequest<{ service: unknown }>(
          `/projects/${projectId}/services/${svc.id}/drift/${action}`,
          { method: "POST" },
        );
        if (isJsonMode()) {
          printJson(res.service);
          return;
        }
        ok(
          action === "accept"
            ? `  Accepted upstream compose changes for "${svc.name}".`
            : `  Kept your edits for "${svc.name}".`,
        );
      } catch (e) {
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
      const qs = opts.env ? `?environment=${encodeURIComponent(opts.env)}` : "";
      const res = await apiRequest<{ vars: Record<string, unknown>[] }>(
        `/projects/${projectId}/services/${svc.id}/env${qs}`,
      );
      const vars = res.vars ?? [];
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
      const environment: string = opts.env;
      const desired = parsePairs(pairs);
      const isSecret = Boolean(opts.secret);

      // The service env endpoint is a full replace (delete-then-insert for this
      // environment scope), so a partial set must first read the current vars
      // and merge — otherwise unspecified vars would be wiped.
      let vars: { key: string; value: string; isSecret: boolean }[];
      if (opts.replace) {
        vars = Object.entries(desired).map(([key, value]) => ({ key, value, isSecret }));
      } else {
        const cur = await apiRequest<{
          vars: { key: string; value: string; isSecret?: boolean }[];
        }>(
          `/projects/${projectId}/services/${svc.id}/env?environment=${encodeURIComponent(environment)}`,
        );
        const existing = cur.vars ?? [];
        // Secret values come back masked, so they can't be re-sent through a
        // full replace. Refuse rather than silently corrupt them.
        const droppedSecrets = existing.filter((v) => v.isSecret && !(v.key in desired));
        if (droppedSecrets.length) {
          err(
            `  This environment has secret var(s) whose values can't be read back: ` +
              `${droppedSecrets.map((v) => v.key).join(", ")}.\n` +
              "  Re-specify them in this command, or pass --replace to drop unspecified vars.",
          );
          process.exit(1);
        }
        const merged = new Map<string, { key: string; value: string; isSecret: boolean }>();
        for (const v of existing) {
          if (!v.isSecret) merged.set(v.key, { key: v.key, value: v.value, isSecret: false });
        }
        for (const [key, value] of Object.entries(desired)) {
          merged.set(key, { key, value, isSecret });
        }
        vars = [...merged.values()];
      }

      await apiRequest(`/projects/${projectId}/services/${svc.id}/env`, {
        method: "PUT",
        body: JSON.stringify({ environment, vars }),
      });
      ok(
        `  Set ${Object.keys(desired).length} variable(s) on "${svc.name}" (${environment}); ` +
          `${vars.length} total now stored.`,
      );
    } catch (e) {
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
      const tail = opts.tail ? `?tail=${encodeURIComponent(opts.tail)}` : "";

      if (!opts.follow) {
        const res = await apiRequest<{
          data: { timestamp?: string; message?: string; level?: string }[];
        }>(`/projects/${projectId}/services/${svc.id}/logs${tail}`);
        const entries = res.data ?? [];
        if (isJsonMode()) {
          printJson(entries);
          return;
        }
        for (const e of entries) printLogEntry(e);
        return;
      }

      for await (const ev of sseRequest(
        `/projects/${projectId}/services/${svc.id}/logs/stream${tail}`,
      )) {
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

// ─── exec (interactive terminal — stubbed) ────────────────────────────────────

const execCmd = stackCommand("exec")
  .description("Open an interactive shell in a service container (coming soon)")
  .argument("[service]", "Service name or id")
  .action(() => {
    err(
      "  `openship service exec` is not available yet — an interactive terminal needs a\n" +
        "  WebSocket client (the CLI ships no ws dependency). Use the dashboard's service\n" +
        "  terminal for now.",
    );
    process.exit(1);
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
