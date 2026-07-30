import { createHash } from "node:crypto";
import type { CommandExecutor } from "../../types";
import { sq } from "../git-clone";
import {
  groupSwarmStacks,
  normalizeSwarmManagerInfo,
  normalizeSwarmNamedObject,
  normalizeSwarmNetwork,
  normalizeSwarmNode,
  normalizeSwarmService,
  normalizeSwarmTask,
  normalizeSwarmVolume,
  SwarmProbeError,
} from "./normalize";
import type {
  StackRuntimeAdapter,
  SwarmDiscoveryDiagnostic,
  SwarmDiscoverySnapshot,
  SwarmManagerInfo,
  RenderStackInput,
  RenderedStack,
} from "./types";

export interface SwarmRuntimeOptions {
  executor: Pick<CommandExecutor, "exec"> & Partial<Pick<CommandExecutor, "writeFile" | "readFile" | "rm">>;
  /** Bounded so a failed manager/SSH link cannot pin an API request. */
  timeoutMs?: number;
  /** Bound a malformed/large manager response before it reaches an API payload. */
  maxResources?: number;
}

export class SwarmRenderError extends Error {
  constructor(
    readonly issues: import("./types").SwarmRenderIssue[],
    message = "Docker rejected the stack configuration.",
  ) {
    super(message);
    this.name = "SwarmRenderError";
  }
}

const MAX_RENDER_SOURCE_FILES = 250;
const STAGING_PREFIX = "/tmp/openship-swarm-render.";

function assertStagingPath(path: string): string {
  const normalized = path.trim().replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /[\u0000-\u001f\u007f]/.test(normalized) ||
    normalized.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new SwarmRenderError([{ code: "SWARM_STACK_RENDER_UNAVAILABLE", message: "A stack source path is unsafe for manager rendering." }]);
  }
  return normalized;
}

function shellValue(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function explicitEnvironment(environment: Record<string, string>): string {
  return Object.entries(environment)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
        throw new SwarmRenderError([{ code: "SWARM_STACK_INTERPOLATION_FAILED", message: "An interpolation variable name is invalid." }]);
      }
      return `${key}=${shellValue(value)}`;
    })
    .join("\n") + "\n";
}

function overrideYaml(labelsByService: Record<string, Record<string, string>>): string {
  const services = Object.entries(labelsByService).sort(([a], [b]) => a.localeCompare(b));
  if (services.length === 0) return "services: {}\n";
  // JSON strings are valid YAML scalars and avoid bespoke quoting rules.
  return `services:\n${services.map(([service, labels]) =>
    `  ${JSON.stringify(service)}:\n    deploy:\n      labels:\n${Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `        ${JSON.stringify(key)}: ${JSON.stringify(value)}`)
      .join("\n")}`,
  ).join("\n")}\n`;
}

function canonicalRenderedYaml(value: string): string {
  return `${value.replaceAll("\r\n", "\n").replace(/\n+$/, "")}\n`;
}

function renderedDigest(value: string): string {
  return `sha256:${createHash("sha256").update(canonicalRenderedYaml(value)).digest("hex")}`;
}

function safeWarnings(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 20)
    // Docker's warnings should name features, not include source/env values.
    .map((line) => line.length > 500 ? `${line.slice(0, 500)}…` : line);
}

/**
 * Manager-scoped Swarm CLI adapter. It deliberately starts read-only: no stack
 * command is available until source rendering and managed-stack claim gates are
 * implemented. The executor is shared with the Platform and is not disposed.
 */
export class SwarmRuntime implements StackRuntimeAdapter {
  readonly name = "swarm" as const;
  private readonly timeoutMs: number;
  private readonly maxResources: number;

  private constructor(
    private readonly executor: SwarmRuntimeOptions["executor"],
    options: SwarmRuntimeOptions,
  ) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.maxResources = options.maxResources ?? 250;
  }

  static async create(options: SwarmRuntimeOptions): Promise<SwarmRuntime> {
    const runtime = new SwarmRuntime(options.executor, options);
    await runtime.probe();
    return runtime;
  }

  async probe(): Promise<SwarmManagerInfo> {
    let infoText: string;
    let serverText: string;
    try {
      infoText = await this.executor.exec("docker info --format '{{json .}}'", {
        timeout: this.timeoutMs,
      });
      serverText = await this.executor.exec("docker version --format '{{json .Server}}'", {
        timeout: this.timeoutMs,
      });
    } catch {
      throw new SwarmProbeError(
        "SWARM_MANAGER_UNREACHABLE",
        "Unable to reach Docker on this target. Verify the manager connection and Docker permissions.",
      );
    }

    try {
      return normalizeSwarmManagerInfo(JSON.parse(infoText), JSON.parse(serverText));
    } catch (err) {
      if (err instanceof SwarmProbeError) throw err;
      throw new SwarmProbeError(
        "SWARM_INVALID_INFO",
        "Docker returned an unreadable manager response while probing Docker Swarm.",
      );
    }
  }

  /**
   * Read the manager's operational shape. Every command is read-only, parsed
   * locally, and bounded. A failed optional listing becomes a diagnostic rather
   * than turning a healthy manager into a false negative.
   */
  async discover(): Promise<SwarmDiscoverySnapshot> {
    const manager = await this.probe();
    const diagnostics: SwarmDiscoveryDiagnostic[] = [];
    const observedAt = new Date().toISOString();

    const nodes = (await this.readJsonLines("docker node ls --format '{{json .}}'", "nodes", diagnostics))
      .slice(0, this.maxResources)
      .map(normalizeSwarmNode)
      .filter((node) => node.id);

    const serviceIds = await this.readLines("docker service ls -q", "services", diagnostics);
    if (serviceIds.length > this.maxResources) {
      diagnostics.push({ resource: "services", message: `Discovery capped at ${this.maxResources} services.` });
    }
    const services = [];
    for (const serviceId of serviceIds.slice(0, this.maxResources)) {
      const rows = await this.readJsonLines(
        `docker service inspect --format '{{json .}}' ${sq(serviceId)}`,
        "services",
        diagnostics,
      );
      for (const row of rows) {
        const service = normalizeSwarmService(row);
        if (service.id) services.push(service);
      }
    }

    const tasks = [];
    for (const service of services) {
      const rows = await this.readJsonLines(
        `docker service ps ${sq(service.id)} --no-trunc --format '{{json .}}'`,
        "tasks",
        diagnostics,
      );
      for (const row of rows.slice(0, this.maxResources)) {
        const task = normalizeSwarmTask(row, service, observedAt);
        if (task.id) tasks.push(task);
      }
    }

    const networks = (await this.readJsonLines("docker network ls --filter scope=swarm --format '{{json .}}'", "networks", diagnostics))
      .slice(0, this.maxResources)
      .map(normalizeSwarmNetwork)
      .filter((network) => network.id);
    const volumes = (await this.readJsonLines("docker volume ls --format '{{json .}}'", "volumes", diagnostics))
      .slice(0, this.maxResources)
      .map(normalizeSwarmVolume)
      .filter((volume) => volume.name);
    const configs = (await this.readJsonLines("docker config ls --format '{{json .}}'", "configs", diagnostics))
      .slice(0, this.maxResources)
      .map(normalizeSwarmNamedObject)
      .filter((config) => config.id && config.name);
    // `docker secret ls` intentionally lists metadata only. Never inspect a
    // secret: the payload is not useful for discovery and must not enter memory.
    const secrets = (await this.readJsonLines("docker secret ls --format '{{json .}}'", "secrets", diagnostics))
      .slice(0, this.maxResources)
      .map(normalizeSwarmNamedObject)
      .filter((secret) => secret.id && secret.name);

    return {
      manager,
      nodes,
      stacks: groupSwarmStacks(services),
      services,
      tasks,
      networks,
      volumes,
      configs,
      secrets,
      diagnostics,
      observedAt,
    };
  }

  /**
   * Render exactly through Docker's Swarm-aware Compose implementation. This
   * writes only an ephemeral 0700 manager directory and runs no stack apply.
   */
  async renderStack(input: RenderStackInput): Promise<RenderedStack> {
    const executor = this.executor;
    if (!executor.writeFile || !executor.readFile || !executor.rm) {
      throw new SwarmRenderError([{ code: "SWARM_STACK_RENDER_UNAVAILABLE", message: "This manager transport cannot safely stage a stack render." }]);
    }
    if (input.files.length === 0 || input.files.length > MAX_RENDER_SOURCE_FILES) {
      throw new SwarmRenderError([{ code: "SWARM_STACK_RENDER_UNAVAILABLE", message: "Stack rendering requires a bounded non-empty source file set." }]);
    }
    const files = input.files.map((file) => ({ ...file, path: assertStagingPath(file.path) }));
    const composePaths = input.composePaths.map((path) => assertStagingPath(path));
    if (composePaths.length === 0 || composePaths.some((path) => !files.some((file) => file.path === path))) {
      throw new SwarmRenderError([{ code: "SWARM_STACK_RENDER_UNAVAILABLE", message: "Every ordered compose path must be present in the staged source files." }]);
    }

    let stage: string | null = null;
    try {
      const created = await executor.exec(`umask 077 && mktemp -d ${STAGING_PREFIX}XXXXXX`, { timeout: this.timeoutMs });
      stage = created.trim();
      if (!new RegExp(`^${STAGING_PREFIX.replace(".", "\\.")}[A-Za-z0-9]+$`).test(stage)) {
        throw new SwarmRenderError([{ code: "SWARM_STACK_RENDER_UNAVAILABLE", message: "Manager returned an invalid staging directory." }]);
      }
      for (const file of files) await executor.writeFile(`${stage}/${file.path}`, file.content);

      const environmentPath = `${stage}/.openship-render.env`;
      const overridePath = `${stage}/.openship-render.override.yaml`;
      const warningsPath = `${stage}/.openship-render.warnings`;
      const override = overrideYaml(input.ownershipLabels ?? {});
      await executor.writeFile(environmentPath, explicitEnvironment(input.environment ?? {}));
      await executor.writeFile(overridePath, override);
      const command = [
        `cd ${sq(stage)} &&`,
        `env -i PATH="$PATH" sh -c ${sq('set -a; . "$1"; shift; exec "$@"')} sh ${sq(environmentPath)}`,
        "docker stack config",
        ...composePaths.flatMap((path) => ["--compose-file", sq(`${stage}/${path}`)]),
        "--compose-file",
        sq(overridePath),
        `2>${sq(warningsPath)}`,
      ].join(" ");
      let renderedYaml: string;
      try {
        renderedYaml = await executor.exec(command, { timeout: this.timeoutMs });
      } catch (error) {
        const message = error instanceof Error && /variable|interpolat/i.test(error.message)
          ? "Docker could not interpolate a required stack variable. Provide it in the explicit render environment."
          : "Docker rejected the stack configuration. Check Compose syntax, source paths, and Swarm compatibility.";
        throw new SwarmRenderError([{ code: /variable|interpolat/i.test(error instanceof Error ? error.message : "")
          ? "SWARM_STACK_INTERPOLATION_FAILED"
          : "SWARM_STACK_CONFIG_FAILED", message }]);
      }
      const warnings = safeWarnings(await executor.readFile(warningsPath).catch(() => ""));
      const canonical = canonicalRenderedYaml(renderedYaml);
      return { renderedYaml: canonical, renderedDigest: renderedDigest(canonical), overrideYaml: override, warnings };
    } finally {
      if (stage) await executor.rm(stage).catch(() => {});
    }
  }

  private async readLines(
    command: string,
    resource: SwarmDiscoveryDiagnostic["resource"],
    diagnostics: SwarmDiscoveryDiagnostic[],
  ): Promise<string[]> {
    try {
      const output = await this.executor.exec(command, { timeout: this.timeoutMs });
      return output.split("\n").map((line) => line.trim()).filter(Boolean);
    } catch {
      diagnostics.push({ resource, message: `Unable to list Swarm ${resource} from this manager.` });
      return [];
    }
  }

  private async readJsonLines(
    command: string,
    resource: SwarmDiscoveryDiagnostic["resource"],
    diagnostics: SwarmDiscoveryDiagnostic[],
  ): Promise<unknown[]> {
    const lines = await this.readLines(command, resource, diagnostics);
    const result: unknown[] = [];
    for (const line of lines) {
      try {
        result.push(JSON.parse(line));
      } catch {
        diagnostics.push({ resource, message: `Manager returned an unreadable ${resource} record.` });
      }
    }
    return result;
  }

  async dispose(): Promise<void> {
    // The caller owns the platform executor/SSH transport; no-op by design.
  }
}
