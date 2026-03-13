/**
 * Cloud runtime — delegates build/deploy to Oblien cloud infrastructure.
 *
 * Strategy: single workspace per deployment.
 *   1. Build: create temp workspace (high resources) → shared pipeline (clone → install → build)
 *   2. Deploy: makePermanent → resize down → create workload → expose port
 *   3. Redeploy: new workspace, build, swap routing, delete old
 */

import { Oblien } from "oblien";
import type { WorkspaceHandle } from "oblien";
import type { ExecStreamEvent } from "oblien";

import type {
  BuildConfig,
  DeployConfig,
  BuildResult,
  DeploymentResult,
  LogEntry,
  LogCallback,
  ContainerInfo,
  ResourceUsage,
  ContainerStatus,
} from "../types";

import type { RuntimeAdapter, RuntimeCapability } from "./types";
import { BuildLogger, runBuildPipeline, type BuildEnvironment } from "./build-pipeline";

function now(): string {
  return new Date().toISOString();
}

// ─── CloudRuntime ────────────────────────────────────────────────────────────

export class CloudRuntime implements RuntimeAdapter {
  readonly name = "cloud";
  readonly capabilities: ReadonlySet<RuntimeCapability> = new Set<RuntimeCapability>([
    "build",
    "deploy",
    "stop",
    "start",
    "restart",
    "destroy",
    "containerInfo",
    "runtimeLogs",
    "streamLogs",
    "usage",
    "containerIp",
  ]);

  private readonly client: Oblien;

  constructor(clientId: string, clientSecret: string) {
    this.client = new Oblien({ clientId, clientSecret });
  }

  supports(cap: RuntimeCapability): boolean {
    return this.capabilities.has(cap);
  }

  async dispose(): Promise<void> {
    // No persistent connections to clean up
  }

  /** Get a scoped workspace handle. */
  private ws(workspaceId: string): WorkspaceHandle {
    return this.client.workspace(workspaceId);
  }

  // ── Build lifecycle ────────────────────────────────────────────────────

  async build(config: BuildConfig, logger?: BuildLogger): Promise<BuildResult> {
    const log = logger ?? new BuildLogger();

    // 1. Provision workspace + acquire runtime token (logs to terminal)
    let wsId: string;
    let rt: Awaited<ReturnType<WorkspaceHandle["runtime"]>>;
    try {
      const provisioned = await this.provisionBuildWorkspace(config, log);
      wsId = provisioned.workspaceId;
      rt = provisioned.runtime;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.log(`Failed to provision build environment: ${msg}`, "error");
      return {
        sessionId: config.sessionId,
        status: "failed" as const,
        durationMs: 0,
      };
    }

    // 2. Build environment — exec delegates to cloud runtime API
    const buildEnv: BuildEnvironment = {
      projectDir: "/app",
      hasNativeEnv: true,
      exec: async (command, logCb) => {
        await this.execAndStream(rt, ["sh", "-c", command], logCb);
      },
    };

    // 3. Run shared build pipeline (clone → install → build)
    const result = await runBuildPipeline(buildEnv, config, log);

    return {
      sessionId: config.sessionId,
      status: result.status,
      imageRef: wsId,
      durationMs: result.durationMs,
    };
  }

  /**
   * Provision a temporary cloud workspace for a build.
   *
   * This is the cloud-specific "prepare" phase:
   *   1. Create workspace (image + resources + env vars)
   *   2. Set TTL for auto-cleanup
   *   3. Acquire runtime token (enable API server + get JWT)
   *
   * Output streams to the terminal via logger so the user sees
   * progress before the numbered build steps begin.
   */
  private async provisionBuildWorkspace(
    config: BuildConfig,
    logger: BuildLogger,
  ): Promise<{ workspaceId: string; runtime: Awaited<ReturnType<WorkspaceHandle["runtime"]>> }> {
    logger.log("Provisioning build environment...\n");

    // Create temporary workspace with build resources
    const envArray = Object.entries(config.envVars).map(
      ([k, v]) => `${k}=${v}`,
    );

    const wsData = await this.client.workspaces.create({
      name: `build-${config.projectId}-${config.sessionId.slice(0, 8)}`,
      image: config.buildImage,
      mode: "temporary",
      config: {
        cpus: config.resources.cpuCores,
        memory_mb: config.resources.memoryMb,
        disk_size_mb: config.resources.diskMb,
        env: envArray,
      },
    });

    const ws = this.ws(wsData.id);

    try {
      // Set TTL via dedicated lifecycle API (config.ttl during create is unreliable)
      try {
        await ws.lifecycle.makeTemporary({ ttl: "15m", ttl_action: "remove", remove_on_exit: true });
      } catch {
        // TTL failure is non-fatal — workspace will be cleaned up eventually
      }

      // Acquire runtime handle (enables API server + gets JWT)
      logger.log("Connecting to build environment...\n");
      let rt: Awaited<ReturnType<WorkspaceHandle["runtime"]>> | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          rt = await ws.runtime();
          break;
        } catch (err) {
          if (attempt < 2) {
            await new Promise((r) => setTimeout(r, 2000));
          } else {
            throw err;
          }
        }
      }
      if (!rt) throw new Error("Failed to connect to build environment");

      logger.log("Build environment ready\n");

      return { workspaceId: wsData.id, runtime: rt };
    } catch (err) {
      // Workspace was created but setup failed — clean it up
      await ws.delete().catch(() => {});
      throw err;
    }
  }

  async cancelBuild(sessionId: string): Promise<void> {
    // The workspace ID is stored as imageRef — build.service.ts calls destroy() directly
    void sessionId;
  }

  async getBuildLogs(sessionId: string): Promise<LogEntry[]> {
    // Build logs are streamed in real-time via onLog callback
    // Historical logs are stored in the database by build.service.ts
    void sessionId;
    return [];
  }

  // ── Deploy lifecycle ───────────────────────────────────────────────────

  async deploy(config: DeployConfig): Promise<DeploymentResult> {
    const workspaceId = config.imageRef;
    if (!workspaceId) {
      return {
        deploymentId: config.deploymentId,
        status: "failed",
      };
    }

    const ws = this.ws(workspaceId);

    try {
      // 1. Make workspace permanent (it was temporary during build)
      await ws.lifecycle.makePermanent();
    } catch (err) {
      throw new Error(`Failed to make workspace permanent: ${err instanceof Error ? err.message : err}`);
    }

    try {
      // 2. Resize CPU/memory to production levels
      //    Disk is NOT resized down — VMs don't support disk shrink.
      //    The build disk size carries over (harmless, just extra space).
      await ws.resources.update({
        cpus: config.resources.cpuCores,
        memory_mb: config.resources.memoryMb,
        apply: true,
      });
    } catch (err) {
      throw new Error(`Failed to resize workspace: ${err instanceof Error ? err.message : err}`);
    }

    // 3. Create a workload for the application process
    const startCommand = config.startCommand || "npm start";
    const envArray = Object.entries(config.envVars).map(
      ([k, v]) => `${k}=${v}`,
    );

    const restartPolicy = config.restartPolicy === "no" ? "never" as const
      : (config.restartPolicy ?? "always") as "always" | "on-failure" | "never";

    try {
      await ws.workloads.create({
        name: "app",
        cmd: [startCommand],
        working_dir: "/app",
        env: [
          ...envArray,
          `PORT=${config.port}`,
        ],
        restart_policy: restartPolicy,
        max_restarts: 10,
      });
    } catch (err) {
      throw new Error(`Failed to create workload: ${err instanceof Error ? err.message : err}`);
    }

    // 4. Expose the application port with free subdomain (slug.opsh.io)
    let url: string | undefined;
    try {
      const exposeParams: { port: number; slug?: string; domain?: string } = {
        port: config.port,
        domain: "opsh.io",
      };
      if (config.slug) exposeParams.slug = config.slug;
      const exposeResult = await ws.publicAccess.expose(exposeParams);
      url = (exposeResult as Record<string, unknown>).url as string | undefined;
    } catch (err) {
      throw new Error(`Failed to expose port ${config.port}: ${err instanceof Error ? err.message : err}`);
    }

    // 5. Connect custom domain if provided (separate from free subdomain)
    if (config.customDomain) {
      try {
        await ws.domains.connect({
          domain: config.customDomain,
          port: config.port,
        });
      } catch (err) {
        // Non-fatal: custom domain can be retried later
        console.error(`Failed to connect custom domain ${config.customDomain}: ${err instanceof Error ? err.message : err}`);
      }
    }

    return {
      deploymentId: config.deploymentId,
      containerId: workspaceId,
      url: url ?? undefined,
      status: "running",
    };
  }

  /**
   * Deploy a static site via Oblien Pages.
   *
   * Flow:
   *   1. Create a page from the workspace build output → files copied to edge
   *   2. Page goes live immediately on CDN
   *   3. Delete the workspace — page is independent, no VM needed
   *
   * The "containerId" in the result is the page ID (for future updates/teardown).
   */
  async deployStatic(config: DeployConfig & { outputDirectory: string; projectName?: string }): Promise<DeploymentResult> {
    const workspaceId = config.imageRef;
    if (!workspaceId) {
      return { deploymentId: config.deploymentId, status: "failed" };
    }

    // 1. Create page via Pages API — export build output from workspace
    const outputPath = config.outputDirectory.startsWith("/")
      ? config.outputDirectory
      : `/app/${config.outputDirectory}`;

    const slug = `${config.projectId.slice(0, 20)}-${config.deploymentId.slice(0, 8)}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-");

    const pageData = await this.client._http.request<{
      id: string;
      url?: string;
      slug?: string;
    }>({
      method: "POST",
      path: "/pages",
      body: {
        workspace_id: workspaceId,
        path: outputPath,
        name: config.projectName ?? slug,
        slug,
      },
    });

    // 2. Delete the workspace — page lives independently on the edge
    await this.ws(workspaceId).delete().catch(() => {
      // Non-fatal: workspace has TTL and will auto-cleanup
    });

    return {
      deploymentId: config.deploymentId,
      containerId: `page:${pageData.id}`,
      url: pageData.url ?? undefined,
      status: "running",
    };
  }

  async stop(containerId: string): Promise<void> {
    await this.ws(containerId).stop();
  }

  async start(containerId: string): Promise<void> {
    await this.ws(containerId).start();
  }

  async restart(containerId: string): Promise<void> {
    await this.ws(containerId).restart();
  }

  async destroy(containerId: string): Promise<void> {
    await this.ws(containerId).delete();
  }

  // ── Observability ──────────────────────────────────────────────────────

  async getContainerInfo(containerId: string): Promise<ContainerInfo> {
    const data = await this.ws(containerId).get();

    const statusMap: Record<string, ContainerStatus> = {
      running: "running",
      stopped: "stopped",
      starting: "deploying",
      stopping: "stopped",
      creating: "building",
      error: "failed",
    };

    return {
      containerId,
      status: statusMap[data.status] ?? "stopped",
      ip: (data as Record<string, unknown>).ip as string | undefined,
    };
  }

  async getRuntimeLogs(containerId: string, tail?: number): Promise<LogEntry[]> {
    const result = await this.ws(containerId).logs.get({
      source: "cmd",
      tail_lines: tail ?? 100,
    });

    const lines = (result as Record<string, unknown>).logs;
    if (!Array.isArray(lines)) return [];

    return lines.map((line: unknown) => {
      if (typeof line === "string") {
        return { timestamp: now(), message: line, level: "info" as const };
      }
      const entry = line as Record<string, unknown>;
      return {
        timestamp: (entry.timestamp as string) ?? now(),
        message: (entry.message as string) ?? String(line),
        level: "info" as const,
      };
    });
  }

  async streamRuntimeLogs(
    containerId: string,
    onLog: LogCallback,
    opts?: { tail?: number },
  ): Promise<() => void> {
    let cancelled = false;

    const run = async () => {
      try {
        const stream = this.ws(containerId).logs.streamCmd({
          tail_lines: opts?.tail ?? 100,
        });

        for await (const event of stream) {
          if (cancelled) break;
          onLog({
            timestamp: event.timestamp ?? now(),
            message: event.message,
            level: "info",
          });
        }
      } catch {
        // Stream ended or was cancelled
      }
    };

    void run();
    return () => { cancelled = true; };
  }

  async getUsage(containerId: string): Promise<ResourceUsage> {
    const result = await this.ws(containerId).metrics.stats();
    const stats = result as Record<string, unknown>;
    return {
      cpuPercent: (stats.cpu_usage as number) ?? 0,
      memoryMb: (stats.memory_usage as number) ?? 0,
      diskMb: (stats.disk_usage as number) ?? 0,
      networkRxBytes: ((stats.network as Record<string, unknown>)?.rx as number) ?? 0,
      networkTxBytes: ((stats.network as Record<string, unknown>)?.tx as number) ?? 0,
    };
  }

  // ── Network ────────────────────────────────────────────────────────────

  async getContainerIp(containerId: string): Promise<string | null> {
    const data = await this.ws(containerId).get();
    return (data as Record<string, unknown>).ip as string ?? null;
  }

  // ── Account ────────────────────────────────────────────────────────────

  /** Check cloud credentials and account status. Throws on failure. */
  async getQuota(): Promise<unknown> {
    return this.client.workspaces.getQuota();
  }

  // ── Domain validation ──────────────────────────────────────────────────

  /**
   * Validate DNS for a custom domain.
   * Uses Oblien's standalone `domain.validate()` — no workspace needed.
   * Called by preflight before deploy starts.
   */
  async validateDomain(domain: string): Promise<{
    verified: boolean;
    cname: boolean;
    ownership: boolean | null;
    errors: string[];
    requiredRecords: {
      cname: { host: string; target: string };
      txt: { host: string; value: string };
    };
  }> {
    const result = await this.client.domain.validate({ domain });
    return {
      verified: result.verified,
      cname: result.cname,
      ownership: result.ownership,
      errors: result.errors,
      requiredRecords: {
        cname: result.required_records.cname,
        txt: result.required_records.txt,
      },
    };
  }


  // ── Private helpers ────────────────────────────────────────────────────

  /**
   * Execute a command via the runtime exec API and stream output to the log callback.
   * Oblien returns stdout/stderr as native base64 — we pass it through directly
   * via rawData so session-manager forwards it to the frontend without re-encoding.
   * message is set to decoded text for DB storage / display.
   * Throws on non-zero exit code.
   */
  private async execAndStream(
    rt: Awaited<ReturnType<WorkspaceHandle["runtime"]>>,
    cmd: string[],
    onLog: LogCallback,
  ): Promise<void> {
    const stream: AsyncGenerator<ExecStreamEvent> = rt.exec.stream(cmd);

    /** Emit a chunk — raw base64 passes straight through to SSE/terminal. */
    const emit = (b64: string, level: LogEntry["level"]) => {
      const message = Buffer.from(b64, "base64").toString("utf-8");
      onLog({ timestamp: now(), message, level, rawData: b64 });
    };

    let exitCode: number | undefined;

    for await (const event of stream) {
      switch (event.event) {
        case "stdout":
          emit(event.data, "info");
          break;
        case "stderr":
          emit(event.data, "warn");
          break;
        case "exit":
          exitCode = event.exit_code;
          break;
        case "output":
          if (event.stdout) emit(event.stdout, "info");
          if (event.stderr) emit(event.stderr, "warn");
          break;
      }
    }

    if (exitCode !== undefined && exitCode !== 0) {
      throw new Error(`Command failed with exit code ${exitCode}: ${cmd.join(" ")}`);
    }
  }
}
