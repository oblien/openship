import { posix } from "node:path";
import type { WorkloadInfo } from "oblien";
import { AppError } from "@repo/core";
import type { ContainerInfo, LogCallback, LogEntry, RuntimeLogStreamOptions } from "../../types";
import type { ProcessSupervisor, SupervisorDeployOpts } from "../supervisor/types";
import { sampleBareUsage, ZERO_USAGE } from "../supervisor/usage";
import { parseLogLevel, sq } from "../build-pipeline";
import {
  managedProcessPorts,
  managedProcessState,
  readManagedProcessStatus,
  waitForManagedProcess,
  type CloudServerConnection,
} from "./server-connection";
import { probeListeningPortState } from "../port-conflict";
import { CLOUD_DOCKER_BRIDGE_PORT } from "./docker-bridge-source";

const isMissing = (error: unknown) => (error as { status?: number })?.status === 404;
const idPattern = /^[A-Za-z0-9_-]{1,160}$/;

function normalizedEnv(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
    throw new Error("The provider did not return the saved process environment");
  return [...value].sort();
}

/** Provider supervision for the shared BareRuntime. Releases and data stay on the server. */
export class CloudProcessSupervisor implements ProcessSupervisor {
  readonly name = "oblien";
  private readonly streams = new Set<AbortController>();

  constructor(
    private readonly server: CloudServerConnection,
    private readonly projectId: string,
    private readonly workDir: string,
  ) {}

  private id(deploymentId: string) {
    if (!idPattern.test(deploymentId)) throw new Error("Invalid bare deployment identity");
    return `openship-${deploymentId}`;
  }

  private pidPath(deploymentId: string) {
    this.id(deploymentId);
    return `${this.workDir}/.pids/${deploymentId}.pid`;
  }

  private assertOwned(workload: WorkloadInfo, deploymentId: string) {
    const labels = workload?.labels as Record<string, unknown> | undefined;
    if (
      workload?.id !== this.id(deploymentId) ||
      labels?.["openship.project"] !== this.projectId ||
      labels?.["openship.deployment"] !== deploymentId
    ) {
      throw new AppError("Process does not belong to this project", 404, "PROCESS_NOT_FOUND");
    }
    return workload;
  }

  private async read(deploymentId: string, live = false) {
    let workload: WorkloadInfo;
    try {
      workload = await this.server.workspace().workloads.get(this.id(deploymentId));
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
    // Ownership failures must not become an idempotent "already missing" result.
    const saved = this.assertOwned(workload, deploymentId);
    return live ? readManagedProcessStatus(this.server.workspace().workloads, saved) : saved;
  }

  private async require(deploymentId: string, live = false) {
    const workload = await this.read(deploymentId, live);
    if (!workload)
      throw new AppError(
        "The saved application process is missing. Redeploy this release.",
        404,
        "PROCESS_NOT_FOUND",
      );
    return workload;
  }

  /** A successful create can still return an identity we cannot manage. Only
   * remove that new process when a fresh read matches the exact create request;
   * missing ownership metadata must never authorize deleting an unrelated one. */
  private async removeRejectedCreation(
    created: WorkloadInfo,
    matchesRequest: (workload: WorkloadInfo) => boolean,
  ): Promise<boolean> {
    if (typeof created?.id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(created.id))
      return false;
    const workloads = this.server.workspace().workloads;
    try {
      const saved = await workloads.get(created.id);
      if (saved.id !== created.id || !matchesRequest(created) || !matchesRequest(saved))
        return false;
      if (!(await workloads.delete(saved.id)).success) return false;
      try {
        await workloads.get(saved.id);
      } catch (error) {
        return isMissing(error);
      }
    } catch {
      // A failed initial read is not proof a just-created process was removed.
    }
    return false;
  }

  async deploy(options: SupervisorDeployOpts) {
    if (options.projectId !== this.projectId) throw new Error("Process belongs to another project");
    const directory = posix.resolve(options.workDir);
    if (!directory.startsWith(`${posix.resolve(this.workDir)}/`))
      throw new Error("Process directory escapes its project");
    await this.server.resume();
    await this.server.executor.mkdir(`${this.workDir}/.pids`);
    const resolved = (await this.server.executor.exec(`readlink -f -- ${sq(directory)}`)).trim();
    if (!resolved.startsWith(`${posix.resolve(this.workDir)}/`))
      throw new Error("Process directory points outside its project");
    const ports = [...new Set(options.ports ?? [options.port])];
    if (
      ports.some(
        (port) =>
          !Number.isInteger(port) || port < 1 || port > 65535 || port === CLOUD_DOCKER_BRIDGE_PORT,
      )
    )
      throw new Error("Invalid managed process port");
    const params = {
      id: this.id(options.deploymentId),
      name: `Openship ${options.projectId} ${options.deploymentId}`,
      // Record PID + start time before exec. A recycled PID must never report
      // another application's resource usage as this deployment's usage.
      cmd: [
        "sh",
        "-lc",
        `set -eu; umask 077; printf '%s ' "$$" > ${sq(this.pidPath(options.deploymentId))}; sed 's/.*) //' /proc/$$/stat | awk '{print $20}' >> ${sq(this.pidPath(options.deploymentId))}; exec sh -lc ${sq(options.startCommand)}`,
      ],
      working_dir: directory,
      env: Object.entries(options.env).map(([key, value]) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0"))
          throw new Error("Invalid process environment");
        return `${key}=${value}`;
      }),
      restart_policy: "always" as const,
      enabled: true,
      labels: {
        "openship.project": this.projectId,
        "openship.deployment": options.deploymentId,
        "openship.ports": JSON.stringify(ports),
      },
    };
    // The saved workload reserves its listeners even while stopped. Inspect,
    // create and start share the server mutation lock with Docker allocation.
    await this.server.runExclusive(async () => {
      const matchesCommand = (saved: WorkloadInfo) =>
        saved.working_dir === params.working_dir &&
        JSON.stringify(saved.command ?? saved.cmd) === JSON.stringify(params.cmd) &&
        JSON.stringify(normalizedEnv(saved.env)) === JSON.stringify(normalizedEnv(params.env));
      const assertConfig = (saved: WorkloadInfo) => {
        if (
          !matchesCommand(saved) ||
          JSON.stringify(managedProcessPorts(saved).sort((a, b) => a - b)) !==
            JSON.stringify([...ports].sort((a, b) => a - b))
        )
          throw new AppError(
            "This deployment already has a different saved process. Start a new deployment.",
            409,
            "PROCESS_CONFIG_CONFLICT",
          );
      };
      const existing = await this.read(options.deploymentId);
      if (existing) {
        assertConfig(existing);
        await this.startUnlocked(options.deploymentId);
        return;
      }
      await this.assertPortsAvailable(ports);
      let created: WorkloadInfo;
      try {
        created = await this.server.workspace().workloads.create(params);
      } catch (error) {
        if ((error as { status?: number })?.status !== 409) throw error;
        assertConfig(await this.require(options.deploymentId));
        await this.startUnlocked(options.deploymentId);
        return;
      }
      try {
        this.assertOwned(created, options.deploymentId);
        await this.waitForState(options.deploymentId, "running");
      } catch (error) {
        if (!(error instanceof AppError) || error.code !== "PROCESS_NOT_FOUND") throw error;
        const cleaned = await this.removeRejectedCreation(created, (saved) => {
          const labels = saved.labels as Record<string, unknown> | undefined;
          return (
            saved.name === params.name &&
            matchesCommand(saved) &&
            (labels?.["openship.project"] === undefined ||
              labels["openship.project"] === this.projectId) &&
            (labels?.["openship.deployment"] === undefined ||
              labels["openship.deployment"] === options.deploymentId)
          );
        });
        throw new AppError(
          "The Cloud provider did not preserve the application's requested process ID and ownership metadata. " +
            (cleaned
              ? "The new process was removed. Contact support to update the managed runtime before retrying."
              : "Cleanup could not be confirmed. Contact support to check this server before retrying."),
          502,
          cleaned ? "PROCESS_IDENTITY_UNSUPPORTED" : "PROCESS_CLEANUP_REQUIRED",
        );
      }
    });
  }

  private async waitForState(deploymentId: string, expected: "running" | "stopped") {
    return waitForManagedProcess(() => this.require(deploymentId, true), expected);
  }

  private async assertPortsAvailable(ports: number[]) {
    if (!ports.length) return;
    const reserved = new Set(await this.server.publishedPorts(this.projectId));
    for (const port of ports) {
      if (reserved.has(port))
        throw new AppError(
          `Port ${port} is reserved by another application on this server. Choose another port or use Docker isolation.`,
          409,
          "PORT_IN_USE",
        );
      const probe = await probeListeningPortState(this.server.executor, port);
      if (!probe.checked)
        throw new Error(`Could not verify whether port ${port} is available on the server`);
      if (probe.occupant)
        throw new AppError(
          `Port ${port} is already in use on this server. Choose another port or use Docker isolation.`,
          409,
          "PORT_IN_USE",
        );
    }
  }

  async stop(deploymentId: string) {
    return this.server.runExclusive(() => this.stopUnlocked(deploymentId));
  }

  private async stopUnlocked(deploymentId: string) {
    await this.server.state();
    const saved = await this.read(deploymentId);
    if (!saved) return;
    const workloads = this.server.workspace().workloads;
    // The provider's Stop action persists enabled=false with the transition.
    // A separate settings update is not part of its lifecycle contract.
    const stopped = await workloads.stop(saved.id);
    if (!stopped.success) throw new Error("Could not stop the application process");
    await this.waitForState(deploymentId, "stopped");
    if ((await this.require(deploymentId)).enabled !== false)
      throw new Error("The provider did not persist the application's stopped state");
  }

  async start(deploymentId: string) {
    return this.server.runExclusive(() => this.startUnlocked(deploymentId));
  }

  private async startUnlocked(deploymentId: string) {
    await this.server.resume();
    const saved = await this.require(deploymentId);
    const running = await this.isRunning(deploymentId);
    if (running && saved.enabled === true) return;
    if (!running) await this.assertPortsAvailable(managedProcessPorts(saved));
    const workloads = this.server.workspace().workloads;
    const started = await workloads.start(saved.id);
    if (!started.success) throw new Error("Could not start the application process");
    await this.waitForState(deploymentId, "running");
    if ((await this.require(deploymentId)).enabled !== true)
      throw new Error("The provider did not persist the application's enabled state");
  }

  async canStart(deploymentId: string) {
    return Boolean(await this.read(deploymentId));
  }
  async restart(deploymentId: string) {
    return this.server.runExclusive(async () => {
      await this.stopUnlocked(deploymentId);
      await this.startUnlocked(deploymentId);
    });
  }

  async destroy(deploymentId: string) {
    return this.server.runExclusive(async () => {
      await this.server.state();
      const saved = await this.read(deploymentId);
      if (!saved) return;
      const deleted = await this.server.workspace().workloads.delete(saved.id);
      if (!deleted.success) throw new Error("Could not remove the application process");
      if (await this.read(deploymentId))
        throw new Error("The provider still reports the application process after deletion");
      // The server and retained release directories belong to their own lifecycle.
    });
  }

  async getInfo(deploymentId: string): Promise<ContainerInfo> {
    const hostState = await this.server.state();
    if (hostState !== "running") return { containerId: deploymentId, status: hostState };
    const workload = await this.read(deploymentId, true);
    if (!workload) return { containerId: deploymentId, status: "missing" };
    const status = managedProcessState(workload);
    const ports = managedProcessPorts(workload);
    return {
      containerId: deploymentId,
      status,
      ip: "127.0.0.1",
      ...(ports.length
        ? {
            hostPort: ports[0],
            hostPortByContainerPort: Object.fromEntries(ports.map((port) => [port, port])),
          }
        : {}),
    };
  }

  async isRunning(deploymentId: string) {
    return (await this.getInfo(deploymentId)).status === "running";
  }

  async ports() {
    const workloads = await this.server.workspace().workloads.list();
    return workloads.flatMap((workload) => {
      const labels = workload.labels as Record<string, unknown> | undefined;
      if (labels?.["openship.project"] !== this.projectId) return [];
      return managedProcessPorts(workload);
    });
  }

  async listProjectDeploymentIds(projectId: string): Promise<string[]> {
    if (projectId !== this.projectId)
      throw new Error("Process inventory belongs to another project");
    const workloads = await this.server.workspace().workloads.list();
    return workloads.flatMap((workload) => {
      const labels = workload.labels as Record<string, unknown> | undefined;
      if (labels?.["openship.project"] !== projectId) return [];
      const deploymentId = labels["openship.deployment"];
      if (typeof deploymentId !== "string")
        throw new Error("Managed process has no deployment identity");
      this.assertOwned(workload, deploymentId);
      return [deploymentId];
    });
  }

  async getUsage(deploymentId: string) {
    if (!(await this.isRunning(deploymentId))) return { ...ZERO_USAGE };
    const [rawPid, started] = (await this.server.executor.readFile(this.pidPath(deploymentId)))
      .trim()
      .split(/\s+/);
    const pid = Number(rawPid);
    if (!Number.isSafeInteger(pid) || pid <= 1 || !/^\d+$/.test(started ?? ""))
      throw new Error("Application process usage is unavailable");
    const checkIdentity = async () => {
      const actual = (
        await this.server.executor.exec(`sed 's/.*) //' /proc/${pid}/stat | awk '{print $20}'`)
      ).trim();
      if (actual !== started)
        throw new Error("Application process changed while measuring resource usage");
    };
    await checkIdentity();
    const usage = await sampleBareUsage(this.server.executor, pid);
    await checkIdentity();
    return usage;
  }

  async getLogs(deploymentId: string, tail = 200): Promise<LogEntry[]> {
    await this.require(deploymentId);
    if (tail <= 0) return [];
    const result = await this.server.workspace().workloads.logs(this.id(deploymentId), { tail });
    if (!result.success) throw new Error("Could not read the application logs");
    if (typeof result.logs !== "string")
      throw new Error("The provider returned an invalid application log response");
    return result.logs
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-tail)
      .map((message) => ({
        timestamp: new Date().toISOString(),
        level: parseLogLevel(message),
        message,
      }));
  }

  async streamLogs(deploymentId: string, onLog: LogCallback, options?: RuntimeLogStreamOptions) {
    await this.require(deploymentId);
    const controller = new AbortController();
    this.streams.add(controller);
    let closed = false;
    const finish = (error?: unknown) => {
      if (closed) return;
      closed = true;
      this.streams.delete(controller);
      options?.onEnd?.(
        error instanceof Error ? error : error ? new Error(String(error)) : undefined,
      );
    };
    const consume = async () => {
      for await (const entry of this.server
        .workspace()
        .workloads.logsStream(this.id(deploymentId), { signal: controller.signal })) {
        if (controller.signal.aborted) return;
        const message = entry.line ?? entry.data;
        if (typeof message === "string")
          onLog({
            timestamp: entry.timestamp ?? new Date().toISOString(),
            message,
            level: entry.stream === "stderr" ? "error" : parseLogLevel(message),
          });
      }
      finish();
    };
    void consume().catch(finish);
    return () => {
      closed = true;
      this.streams.delete(controller);
      controller.abort();
    };
  }

  async dispose() {
    for (const stream of this.streams) stream.abort();
    this.streams.clear();
  }
}
