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
import { runLocalBuild } from "./local-build";
import { transferLocalDirectory } from "./transfer";

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

  constructor(client: Oblien) {
    this.client = client;
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

    // "local" = build on the API host, then upload output to cloud workspace.
    // "server" (default) = build inside the cloud workspace.
    const buildLocally = config.buildStrategy === "local";

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

    if (buildLocally) {
      log.log("Build strategy: local (build on API host, upload to cloud)\n");

      const result = await runLocalBuild({
        config,
        logger: log,
        transferOutput: async (buildDir) => {
          await transferLocalDirectory(
            buildDir,
            {
              kind: "cloud-runtime",
              runtime: rt,
              path: "/app",
            },
            log,
            { excludes: [] },
          );
        },
      });

      return {
        sessionId: config.sessionId,
        status: result.status,
        imageRef: wsId,
        durationMs: result.durationMs,
      };
    }

    // ── Server build: exec delegates to cloud runtime API ──
    log.log("Build strategy: server (build in cloud workspace)\n");

    const buildEnv: BuildEnvironment = {
      projectDir: "/app",
      hasNativeEnv: true,
      exec: async (command, logCb) => {
        await this.execAndStream(rt, ["sh", "-c", command], logCb);
      },
      preflight: async (cfg, plog) => {
        if (!cfg.localPath) return;
        await transferLocalDirectory(
          cfg.localPath,
          {
            kind: "cloud-runtime",
            runtime: rt,
            path: "/app",
          },
          plog,
        );
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
      name: config.slug ?? `build-${config.projectId.slice(0, 20)}`,
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

  async deploy(config: DeployConfig, onLog?: LogCallback): Promise<DeploymentResult> {
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

    // TODO: temporarily disabled — testing without resource shrink
    // try {
    //   // 2. Resize CPU/memory to production levels
    //   //    Disk is NOT resized down — VMs don't support disk shrink.
    //   //    The build disk size carries over (harmless, just extra space).
    //   await ws.resources.update({
    //     cpus: config.resources.cpuCores,
    //     memory_mb: config.resources.memoryMb,
    //     apply: true,
    //   });
    // } catch (err) {
    //   throw new Error(`Failed to resize workspace: ${err instanceof Error ? err.message : err}`);
    // }

    // 2. Prepare production directory — copy only what's needed at runtime
    const prodPaths = config.productionPaths;
    const workDir = prodPaths?.length ? "/app/production" : "/app";

    if (prodPaths?.length) {
      try {
        const rt = await ws.runtime();
        const logCb: LogCallback = onLog ?? (() => {});

        // Sanitize paths — reject anything that could escape /app/
        const safePaths = prodPaths.filter((p) => {
          const normalized = p.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
          return normalized.length > 0
            && normalized !== ".."
            && !normalized.startsWith("../")
            && !normalized.includes("/../")
            && !normalized.includes("\\");
        });

        if (safePaths.length === 0) {
          throw new Error("No valid production paths after sanitization");
        }

        // Shell-escape a string for use inside single quotes
        const sq = (s: string) => s.replace(/'/g, "'\\''");

        // Build an atomic shell script:
        //   1. Create staging dir
        //   2. Move each path (skip missing with warning)
        //   3. Rename staging → production (atomic on same filesystem)
        //   4. On any error, clean up staging dir
        const moveLines = safePaths.map((p) => {
          const e = sq(p);
          return `if [ -e '/app/${e}' ]; then
  d=$(dirname '${e}')
  mkdir -p "/app/.staging/$d"
  mv '/app/${e}' '/app/.staging/${e}'
  echo "  moved ${e}"
else
  echo "  skip ${e} (not found)"
fi`;
        }).join("\n");

        const script = `set -e
cleanup() { echo "Cleaning up staging dir"; rm -rf /app/.staging; }
echo "Preparing production directory..."
rm -rf /app/.staging
mkdir -p /app/.staging
${moveLines}
if [ "$(ls -A /app/.staging)" ]; then
  rm -rf /app/production
  mv /app/.staging /app/production
  echo "Production directory ready"
else
  cleanup
  echo "ERROR: no files were moved — check production paths"
  exit 1
fi`;

        await this.execAndStream(rt, ["sh", "-c", script], logCb);
      } catch (err) {
        throw new Error(`Failed to prepare production directory: ${err instanceof Error ? err.message : err}`);
      }
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
        cmd: ["sh", "-c", `cd ${workDir} && ${startCommand}`],
        working_dir: workDir,
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

    // 4. Expose via custom domain OR free subdomain — not both
    let url: string | undefined;

    if (config.customDomain) {
      try {
        // publicAccess.expose() opens the firewall implicitly, but with
        // custom domain we skip it — so allow the port via network instead
        await ws.network.update({ ingress_ports: [config.port] });

        await ws.domains.connect({
          domain: config.customDomain,
          port: config.port,
        });
        url = `https://${config.customDomain}`;
      } catch (err) {
        // Fall back to free subdomain if custom domain fails
        console.error(`Failed to connect custom domain ${config.customDomain}: ${err instanceof Error ? err.message : err}`);
        const exposeResult = await ws.publicAccess.expose({
          port: config.port,
          domain: "opsh.io",
          slug: config.slug,
        });
        url = exposeResult.url as string | undefined;
      }
    } else {
      try {
        const exposeResult = await ws.publicAccess.expose({
          port: config.port,
          domain: "opsh.io",
          slug: config.slug,
        });
        url = exposeResult.url as string | undefined;
      } catch (err) {
        throw new Error(`Failed to expose port ${config.port}: ${err instanceof Error ? err.message : err}`);
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

      console.log(`Deploying static site from workspace ${workspaceId}, output path ${outputPath}...`);

    const slug = config.slug
      ?? `${config.projectId.slice(0, 20)}-${config.deploymentId.slice(0, 8)}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-");

    let page: { slug: string; url?: string | null };

    if (config.customDomain) {
      // Deploy with custom domain only — no free subdomain
      const { page: pg } = await this.client.pages.create({
        workspace_id: workspaceId,
        path: outputPath,
        name: config.projectName ?? slug,
        slug,
      });

      await this.client.pages.connectDomain(pg.slug, {
        domain: config.customDomain,
      }).catch(() => {
        // Non-fatal: page can still be accessed via slug if domain isn't verified yet
      });

      page = { ...pg, url: pg.url ?? `https://${config.customDomain}` };
    } else {
      // Deploy with free subdomain (slug.opsh.io)
      const { page: pg } = await this.client.pages.create({
        workspace_id: workspaceId,
        path: outputPath,
        name: config.projectName ?? slug,
        slug,
        domain: 'opsh.io',
      });

      page = pg;
    }

    // // 3. Delete the workspace — page lives independently on the edge
    await this.ws(workspaceId).delete().catch(() => {
      // Non-fatal: workspace has TTL and will auto-cleanup
    });

    return {
      deploymentId: config.deploymentId,
      containerId: `page:${page.slug}`,
      url: page.url ?? undefined,
      status: "running",
    };
  }

  async stop(containerId: string): Promise<void> {
    if (containerId.startsWith("page:")) {
      await this.client.pages.disable(containerId.slice(5));
    } else {
      await this.ws(containerId).stop();
    }
  }

  async start(containerId: string): Promise<void> {
    if (containerId.startsWith("page:")) {
      await this.client.pages.enable(containerId.slice(5));
    } else {
      await this.ws(containerId).start();
    }
  }

  async restart(containerId: string): Promise<void> {
    if (containerId.startsWith("page:")) {
      // Pages are static — no process to restart
      return;
    }
    await this.ws(containerId).restart();
  }

  async destroy(containerId: string): Promise<void> {
    if (containerId.startsWith("page:")) {
      await this.client.pages.delete(containerId.slice(5));
    } else {
      await this.ws(containerId).delete();
    }
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
    try {
      const result = await this.ws(containerId).workloads.logs("app");
      const raw = result as Record<string, unknown>;

      // Oblien returns { logs: "<big string with newlines>" }
      // Each line: [timestamp] stream: message
      if (typeof raw.logs === "string") {
        const logStr = raw.logs as string;
        return logStr.split("\n").filter(Boolean).map((line) => {
          // Parse "[2026-03-14T06:09:25Z] stdout: actual message"
          const match = line.match(/^\[([^\]]+)\]\s+(stdout|stderr):\s?(.*)/);
          if (match) {
            return {
              timestamp: match[1],
              message: match[3],
              level: match[2] === "stderr" ? "warn" as const : "info" as const,
            };
          }
          return { timestamp: now(), message: line, level: "info" as const };
        });
      }

      // Fallback: array shapes
      const lines = Array.isArray(raw.logs) ? raw.logs
        : Array.isArray(raw.entries) ? raw.entries
        : Array.isArray(result) ? result as unknown[]
        : [];
      if (lines.length === 0) return [];

      return lines.map((line: unknown) => {
        if (typeof line === "string") {
          return { timestamp: now(), message: line, level: "info" as const };
        }
        const entry = line as Record<string, unknown>;
        const message = (entry.message as string) ?? (entry.data as string) ?? String(line);
        return {
          timestamp: (entry.timestamp as string) ?? now(),
          message,
          level: entry.stream === "stderr" ? "warn" as const : "info" as const,
        };
      }).filter(e => e.message);
    } catch {
      // Workload may not exist yet — fall back to workspace cmd logs
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
  }

  async streamRuntimeLogs(
    containerId: string,
    onLog: LogCallback,
    opts?: { tail?: number },
  ): Promise<() => void> {
    let cancelled = false;

    const emitText = (text: string, level: LogEntry["level"], timestamp?: string) => {
      if (!text) return; // skip empty entries
      const rawData = Buffer.from(text).toString("base64");
      onLog({ timestamp: timestamp ?? now(), message: text, level, rawData });
    };

    const run = async () => {
      try {
        // 1. Replay existing logs so the terminal isn't blank
        try {
          const history = await this.getRuntimeLogs(containerId, opts?.tail ?? 100);
          for (const entry of history) {
            if (cancelled) return;
            if (!entry.message) continue;
            const rawData = entry.rawData ?? Buffer.from(entry.message).toString("base64");
            onLog({ ...entry, rawData });
          }
        } catch {
          // Historical fetch failed — non-fatal, continue to live stream
        }

        if (cancelled) return;

        // 2. Follow new output from the workload process
        try {
          const stream = this.ws(containerId).workloads.logsStream("app");

          for await (const event of stream) {
            if (cancelled) break;
            const ev = event as Record<string, unknown>;
            const text = (ev.message as string) ?? event.data ?? "";
            emitText(text, event.stream === "stderr" ? "warn" : "info", event.timestamp);
          }
        } catch {
          // Workload stream unavailable — fall back to workspace cmd logs
          if (cancelled) return;
          try {
            const stream = this.ws(containerId).logs.streamCmd({
              tail_lines: opts?.tail ?? 100,
            });

            for await (const event of stream) {
              if (cancelled) break;
              emitText(event.message, "info", event.timestamp);
            }
          } catch {
            // Stream ended or was cancelled
          }
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

  // ── Domain / Slug checks ───────────────────────────────────────────────

  /**
   * Check whether a subdomain slug is available on opsh.io.
   * Uses Oblien's standalone `domain.checkSlug()` — no workspace needed.
   */
  async checkSlug(slug: string, domain = "opsh.io"): Promise<{ available: boolean; url: string }> {
    const result = await this.client.domain.checkSlug({ slug, domain });
    console.log("Slug check result:", result);
    return { available: result.available, url: result.url };
  }

  /**
   * Verify DNS records for a custom domain.
   * Uses Oblien's standalone `domain.verify()` — no workspace needed.
   */
  async verifyDomain(domain: string, resourceId?: string): Promise<{
    verified: boolean;
    cname: boolean;
    ownership: boolean | null;
    errors: string[];
    requiredRecords: {
      cname: { host: string; target: string };
      txt?: { host: string; value: string };
    };
  }> {
    const result = await this.client.domain.verify({ domain, resource_id: resourceId });
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
    timeoutSeconds?: number,
  ): Promise<void> {
    const params = timeoutSeconds ? { timeoutSeconds } : undefined;
    const stream: AsyncGenerator<ExecStreamEvent> = rt.exec.stream(cmd, params);

    /** Collect recent output for error diagnostics */
    const recentOutput: string[] = [];
    const MAX_OUTPUT_LINES = 50;

    /** Emit a chunk — raw base64 passes straight through to SSE/terminal. */
    const emit = (b64: string, level: LogEntry["level"]) => {
      const message = Buffer.from(b64, "base64").toString("utf-8");
      onLog({ timestamp: now(), message, level, rawData: b64 });
      // Keep tail of output for error messages
      recentOutput.push(message);
      if (recentOutput.length > MAX_OUTPUT_LINES) recentOutput.shift();
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
      const output = recentOutput.join("").trim();
      const detail = output ? `\n${output}` : "";
      throw new Error(`Command failed with exit code ${exitCode}${detail}`);
    }
  }
}
