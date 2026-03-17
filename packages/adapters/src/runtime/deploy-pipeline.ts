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
 * Self-hosted: activate creates container, resolveTargetUrl + routing wire Traefik.
 */

import type { DeployConfig, LogCallback, RouteConfig } from "../types";
import type { BuildLogger } from "./build-pipeline";

// ─── Deploy environment abstraction ─────────────────────────────────────────

export interface DeployEnvironment {
  /**
   * Optional pre-deploy validation — fail fast before committing resources.
   *
   * Examples:
   *   - Self-hosted Docker: is the Docker daemon reachable?
   *   - Self-hosted Bare: is the target server accessible via SSH?
   *   - Routing: is nginx/traefik/caddy installed and running?
   *   - Cloud: does the account have capacity / valid credentials?
   *
   * Throw to abort with a descriptive error message.
   */
  preflight?(config: DeployConfig): Promise<void>;

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
}

// ─── Routing abstraction (subset of RoutingProvider) ────────────────────────

export interface DeployRouting {
  registerRoute(route: RouteConfig): Promise<void>;
}

// ─── Pipeline input / output ────────────────────────────────────────────────

export interface DeployPipelineInput {
  config: DeployConfig;
  /** Container ID of the currently-active deployment (to deactivate). */
  previousContainerId?: string;
  /** Verified domains that need routing. */
  domains: Array<{ hostname: string; tls: boolean }>;
  /** Routing provider — omit when routing is handled by the runtime (cloud). */
  routing?: DeployRouting;
}

export interface DeployPipelineResult {
  status: "ready" | "failed";
  containerId?: string;
  url?: string;
  error?: string;
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
  const { config, previousContainerId, domains, routing } = input;

  try {
    logger.step("deploy", "running", "Deploying...");

    // ── Pre-deploy validation ────────────────────────────────────────
    if (env.preflight) {
      await env.preflight(config);
    }

    // ── Step 1: Destroy previous deployment (release slug/domain) ──────
    if (previousContainerId) {
      await env.deactivate(previousContainerId).catch(() => {});
    }

    // ── Step 2: Activate new deployment ──────────────────────────────
    const onLog: LogCallback = (entry) => logger.log(entry.message, entry.level);
    const { containerId, url } = await env.activate(config, onLog);

    if (!containerId) {
      throw new Error("Deploy completed but no container was created");
    }

    // ── Step 3: Register routes ──────────────────────────────────────
    if (routing && env.resolveTargetUrl && domains.length > 0) {
      const targetUrl = await env.resolveTargetUrl(containerId, config.port);

      if (targetUrl) {
        for (const d of domains) {
          await routing
            .registerRoute({ domain: d.hostname, targetUrl, tls: d.tls })
            .catch((err) => {
              console.error(
                `[DEPLOY] Failed to register route for ${d.hostname}:`,
                err,
              );
            });
        }
      }
    }

    logger.step("deploy", "completed", "Deployed successfully");

    return { status: "ready", containerId, url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.step("deploy", "failed", `Deploy failed: ${msg}`);
    logger.log(`\x1b[1;31mDeploy failed: ${msg}\x1b[0m\n`, "error");
    return { status: "failed", error: msg };
  }
}
