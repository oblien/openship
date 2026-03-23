/**
 * Shared deploy pipeline — activate → deactivate old → route.
 *
 * Mirrors build-pipeline.ts: the pipeline defines the SEQUENCE,
 * each runtime provides a DeployEnvironment that implements the steps.
 *
 * The pipeline is composed in the service layer from existing runtime
 * and routing adapter methods — no changes to the RuntimeAdapter interface.
 *
 *   - preflight:        (optional) validate prerequisites before committing
 *   - activate:         runtime.deploy()  → start container/workload/process
 *   - deactivate:       runtime.stop()    → stop previous deployment
 *   - resolveTargetUrl: runtime.getContainerIp() → internal URL for routing
 *   - routing:          routing.registerRoute()   → reverse-proxy config
 *
 * Cloud:       activate handles expose (URL returned), no resolveTargetUrl.
 * Self-hosted: activate creates container, resolveTargetUrl + routing wire Nginx.
 */

import type { DeployConfig, LogCallback, RouteConfig, SslResult } from "../types";
import type { BuildLogger } from "./build-pipeline";
import { DeployError } from "@repo/core";

// ─── Prompt callback ────────────────────────────────────────────────────────

/**
 * Callback that pauses the pipeline and asks the user for a decision.
 * Returns the action string chosen by the user.
 */
export type PromptUserFn = (prompt: {
  promptId: string;
  title: string;
  message: string;
  actions: Array<{ id: string; label: string; variant?: string }>;
  details?: Record<string, unknown>;
}) => Promise<string>;

// ─── Deploy environment abstraction ─────────────────────────────────────────

export interface DeployEnvironment {
  /**
   * Optional pre-deploy validation — fail fast before committing resources.
   *
   * Receives `promptUser` so it can pause the pipeline and ask the user
   * for a decision (e.g. "port is occupied — free it or abort?").
   *
   * Throw to abort with a descriptive error message.
   */
  preflight?(config: DeployConfig, promptUser: PromptUserFn): Promise<void>;

  /** Spin up the new deployment (container / workload / process). */
  activate(config: DeployConfig, onLog: LogCallback): Promise<{ containerId: string; url?: string }>;

  /** Destroy a previous deployment (release slug, domain, resources). */
  deactivate(containerId: string): Promise<void>;

  /**
   * Resolve the internal target URL for reverse-proxy routing.
   *
   * Return null if the container has no routable IP (e.g. not ready yet).
   * Omit entirely when routing is handled by activate() (cloud expose).
   */
  resolveTargetUrl?(containerId: string, port: number): Promise<string | null>;

  /** Resolve a route target directly for proxy or static-file routing. */
  resolveRoute?(containerId: string, config: DeployConfig): Promise<Omit<RouteConfig, "domain" | "tls"> | null>;
}

// ─── Routing abstraction (subset of RoutingProvider) ────────────────────────

export interface DeployRouting {
  registerRoute(route: RouteConfig): Promise<void>;
}

export interface DeploySsl {
  provisionCert(domain: string): Promise<SslResult>;
}

// ─── Pipeline input / output ────────────────────────────────────────────────

export interface DeployPipelineInput {
  config: DeployConfig;
  /** Container ID of the currently-active deployment (to deactivate). */
  previousContainerId?: string;
  /** Verified domains that need routing. */
  domains: Array<{ hostname: string; tls: boolean; provisionSsl?: boolean }>;
  /** Routing provider — omit when routing is handled by the runtime (cloud). */
  routing?: DeployRouting;
  /** SSL provider — used when a domain needs cert provisioning/checks. */
  ssl?: DeploySsl;
  /** Callback to pause and prompt the user — required for interactive preflight. */
  promptUser?: PromptUserFn;
}

export interface DeployPipelineResult {
  status: "ready" | "failed";
  containerId?: string;
  url?: string;
  error?: string;
  /** Machine-readable error code (e.g. PORT_IN_USE) for UI-driven recovery. */
  errorCode?: string;
  /** Structured details about the error (e.g. { port, pid, command }). */
  errorDetails?: Record<string, unknown>;
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

/**
 * Run the deploy pipeline: preflight → activate → deactivate old → route.
 *
 * Called by the service layer after a successful build. The service
 * composes the DeployEnvironment from the RuntimeAdapter's existing
 * methods, so no changes to the adapter interface are needed.
 *
 * Step events ("deploy" running/completed/failed) are owned by this
 * pipeline, just as build-pipeline owns clone/install/build events.
 */
export async function runDeployPipeline(
  env: DeployEnvironment,
  input: DeployPipelineInput,
  logger: BuildLogger,
): Promise<DeployPipelineResult> {
  const { config, previousContainerId, domains, routing, ssl, promptUser } = input;

  try {
    logger.step("deploy", "running", "Deploying...");

    // ── Pre-deploy validation ────────────────────────────────────────
    if (env.preflight) {
      const noopPrompt: PromptUserFn = async () => "abort";
      await env.preflight(config, promptUser ?? noopPrompt);
    }

    // ── Step 1: Destroy previous deployment (release slug/domain) ──────
    if (previousContainerId) {
      try {
        logger.log("Stopping previous deployment…\n");
        await env.deactivate(previousContainerId);
        // Give the OS a moment to release the port / socket.
        await new Promise((r) => setTimeout(r, 1000));
      } catch (err) {
        // Log but don't abort — best-effort teardown so we can still try the new deploy.
        const msg = err instanceof Error ? err.message : String(err);
        logger.log(`Warning: failed to stop previous deployment: ${msg}\n`, "warn");
      }
    }

    // ── Step 2: Activate new deployment ──────────────────────────────
    const onLog: LogCallback = (entry) => logger.log(entry.message, entry.level);
    const { containerId, url } = await env.activate(config, onLog);

    if (!containerId) {
      throw new Error("Deploy completed but no container was created");
    }

    // ── Step 3: Register routes ──────────────────────────────────────
    if (routing && domains.length > 0) {
      const routeTarget = env.resolveRoute
        ? await env.resolveRoute(containerId, config)
        : env.resolveTargetUrl
          ? await env.resolveTargetUrl(containerId, config.port).then((targetUrl) => targetUrl ? { targetUrl } : null)
          : null;

      if (routeTarget) {
        for (const d of domains) {
          logger.log(`Registering route for ${d.hostname}...\n`);
          let routeConfig: RouteConfig;
          const targetUrl = (routeTarget as { targetUrl?: string }).targetUrl;
          const staticRoot = (routeTarget as { staticRoot?: string }).staticRoot;

          if (typeof targetUrl === "string") {
            routeConfig = { domain: d.hostname, tls: d.tls, targetUrl };
          } else if (typeof staticRoot === "string") {
            routeConfig = { domain: d.hostname, tls: d.tls, staticRoot };
          } else {
            throw new DeployError("Resolved route target is invalid", "INVALID_ROUTE_TARGET");
          }

          await routing.registerRoute(routeConfig);

          if (d.provisionSsl && ssl) {
            logger.log(`Checking SSL for ${d.hostname}...\n`);
            await ssl.provisionCert(d.hostname);
          }
        }
      }
    } else if (domains.length === 0) {
      logger.log("No domains configured — skipping routing for this deployment.\n", "warn");
    }

    logger.step("deploy", "completed", "Deployed successfully");

    return { status: "ready", containerId, url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const errorCode = err instanceof DeployError ? err.code : undefined;
    const errorDetails = err instanceof DeployError ? err.details : undefined;
    logger.step("deploy", "failed", `Deploy failed: ${msg}`);
    logger.log(`\x1b[1;31mDeploy failed: ${msg}\x1b[0m\n`, "error");
    return { status: "failed", error: msg, errorCode, errorDetails };
  }
}
