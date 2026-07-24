/**
 * Shared deploy pipeline. The pipeline defines the SEQUENCE; each runtime
 * provides a DeployEnvironment that implements the steps. Composed in the
 * service layer from existing runtime + routing adapter methods.
 *
 *   - preflight:        (optional) validate prerequisites before committing
 *   - activate:         runtime.deploy()  → start container/workload/process
 *   - healthCheck:      (optional, deferred) readiness gate for the new one
 *   - resolveTargetUrl: runtime.getContainerIp() → internal URL for routing
 *   - routing:          routing.registerRoute()   → reverse-proxy config
 *   - deactivate:       runtime.stop()/destroy()  → stop the PREVIOUS one
 *
 * The order of activate vs deactivate depends on env.canOverlap:
 *   - OVERLAP (docker/cloud): activate new → health-gate → route → deactivate
 *     old LAST. Old serves until traffic is repointed (zero-downtime) and a
 *     failure before the repoint leaves it untouched (auto-revert).
 *   - NON-OVERLAP (bare, fixed port): deactivate old → activate new → health →
 *     route, and on failure reactivatePrevious to restore the old one.
 *
 * Cloud:       activate handles expose (URL returned), no resolveTargetUrl.
 * Self-hosted: activate creates container, resolveTargetUrl + routing wire Nginx.
 */

import type { DeployConfig, LogCallback, RouteConfig, SslResult } from "../types";
import type { BuildLogger } from "./build-pipeline";
import { DeployError, safeErrorMessage } from "@repo/core";
import {
  registerResolvedRoutes,
  type RouteRegistrationOptions,
  type RoutedDomainInput,
} from "./route-registration";

// ─── Prompt callback ────────────────────────────────────────────────────────

/**
 * Callback that pauses the pipeline and asks the user for a decision.
 * Returns the action string chosen by the user.
 */
/** A user-decision prompt (edge takeover, port conflict, …) — the ONE shape
 *  shared by the deploy pipeline, server-setup, the CLI, and the dashboard modal
 *  that renders it. Resolves to the chosen action id. */
export interface PromptPayload {
  promptId: string;
  title: string;
  message: string;
  actions: Array<{ id: string; label: string; variant?: string }>;
  details?: Record<string, unknown>;
}

export type PromptUserFn = (prompt: PromptPayload) => Promise<string>;

// ─── Deploy environment abstraction ─────────────────────────────────────────

export interface DeployEnvironment {
  /**
   * Optional pre-deploy validation - fail fast before committing resources.
   *
   * Receives `promptUser` so it can pause the pipeline and ask the user
   * for a decision (e.g. "port is occupied - free it or abort?").
   *
   * Throw to abort with a descriptive error message.
   */
  preflight?(config: DeployConfig, promptUser: PromptUserFn): Promise<void>;

  /** Spin up the new deployment (container / workload / process). */
  activate(config: DeployConfig, onLog: LogCallback): Promise<{ containerId: string; url?: string }>;

  /** Destroy a previous deployment (release slug, domain, resources). */
  deactivate(containerId: string): Promise<void>;

  /**
   * Can the NEW deployment run SIMULTANEOUSLY with the previous one?
   *
   * true  (docker/cloud — unique container name + own host port / isolated
   *        workspace): the pipeline starts → health-gates → routes the new
   *        deployment BEFORE stopping the old one. A failure anywhere before
   *        the route swap leaves the old one untouched and still serving =
   *        zero-downtime on the happy path + zero-impact auto-revert.
   * false (bare — fixed host port): the old process must be stopped before the
   *        new one can bind, so the pipeline keeps the legacy stop-first order
   *        and, on failure, calls reactivatePrevious to bring the old one back.
   *
   * Defaults to falsey (stop-first) — backward-compatible for static/compose.
   */
  canOverlap?: boolean;

  /**
   * Optional readiness gate for the just-activated deployment. Throw to mark
   * the deploy failed — in the overlap path this auto-reverts to the old
   * deployment (it was never touched).
   *
   * DEFERRED SEAM: no runtime implements this yet. It is the single insertion
   * point for the (separately-designed) health-check execution — once a runtime
   * provides it, the pipeline needs no further changes. Until then the call is
   * a no-op.
   */
  healthCheck?(containerId: string, config: DeployConfig): Promise<void>;

  /**
   * Restart a previously-STOPPED deployment — the non-overlap (bare) auto-revert
   * path. Only meaningful when deactivate() merely stopped the old deployment
   * (keeping its artifact on disk) so it can be started again. Omit for runtimes
   * that destroy on deactivate or run old+new concurrently (overlap never stops
   * the old one before success, so there is nothing to restore).
   */
  reactivatePrevious?(previousContainerId: string): Promise<void>;

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
  /** Container ID of the currently-active deployment (undefined on first deploy). */
  previousContainerId?: string;
  /**
   * Whether this run should stop the previous deployment. Defaults to true.
   * Set false when the caller's post-deploy step will stop+RETAIN the old one
   * itself — e.g. snapshot rollback, where archivePreviousDeployment archives
   * the artifact. previousContainerId stays accurate either way; this only
   * controls whether the pipeline calls deactivate.
   */
  deactivatePrevious?: boolean;
  /** Verified domains that need routing. */
  domains: RoutedDomainInput[];
  /** Routing provider - omit when routing is handled by the runtime (cloud). */
  routing?: DeployRouting;
  /** SSL provider - used when a domain needs cert provisioning/checks. */
  ssl?: DeploySsl;
  /** Options for webhook proxy injection during route registration. */
  routeOptions?: RouteRegistrationOptions;
  /** Callback to pause and prompt the user - required for interactive preflight. */
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
  /**
   * Per-domain routing failures on an OTHERWISE-SUCCESSFUL deploy (status
   * "ready"). Domains are optional and routes register after the container is
   * up + healthy, so a routing failure never flips status to "failed" — it's
   * collected here. Callers surface it as a project "routing action required"
   * warning (and clear it on a retry / next clean deploy). Empty/undefined = all
   * routes registered.
   */
  routeWarnings?: string[];
}

// ─── Pipeline ────────────────────────────────────────────────────────────────

/**
 * Run the deploy pipeline. Order depends on env.canOverlap (see file header):
 *   overlap     → activate → health-gate → route → deactivate old (last)
 *   non-overlap → deactivate old → activate → health-gate → route
 *
 * Called by the service layer after a successful build. The service composes
 * the DeployEnvironment from the RuntimeAdapter's existing methods.
 *
 * Step events ("deploy" running/completed/failed) are owned by this pipeline,
 * just as build-pipeline owns clone/install/build events.
 */
export async function runDeployPipeline(
  env: DeployEnvironment,
  input: DeployPipelineInput,
  logger: BuildLogger,
): Promise<DeployPipelineResult> {
  const { config, previousContainerId, domains, routing, ssl, routeOptions, promptUser } = input;
  const overlap = env.canOverlap === true;

  // Track the container we activate so a failure DURING/AFTER routing can
  // report it back to the caller for cleanup — a started-but-unrouted
  // container must not orphan.
  let activatedContainerId: string | undefined;

  // Stop the previous deployment — best-effort, never aborts the deploy.
  // Skipped when the caller opts out (deactivatePrevious === false): the old
  // one keeps serving until the caller's own post-deploy step stops+retains it.
  const deactivatePrevious = async () => {
    if (!previousContainerId || input.deactivatePrevious === false) return;
    try {
      logger.log("Stopping previous deployment…\n");
      await env.deactivate(previousContainerId);
    } catch (err) {
      logger.log(`Warning: failed to stop previous deployment: ${safeErrorMessage(err)}\n`, "warn");
    }
  };

  try {
    logger.step("deploy", "running", "Deploying...");

    // ── Pre-deploy validation ────────────────────────────────────────
    if (env.preflight) {
      const noopPrompt: PromptUserFn = async () => "abort";
      await env.preflight(config, promptUser ?? noopPrompt);
    }

    // ── Non-overlap only: stop OLD first (it holds the fixed port) ─────
    // The new process can't bind until the old one releases the port, so
    // there's an unavoidable downtime window here. Overlap runtimes skip
    // this entirely — the old deployment keeps serving until the route swap.
    if (!overlap && previousContainerId) {
      await deactivatePrevious();
      // Give the OS a moment to release the port / socket.
      await new Promise((r) => setTimeout(r, 1000));
    }

    // ── Activate the new deployment ──────────────────────────────────
    const onLog: LogCallback = (entry) => logger.callback(entry);
    const { containerId, url } = await env.activate(config, onLog);
    activatedContainerId = containerId;

    if (!containerId) {
      throw new Error("Deploy completed but no container was created");
    }

    // ── Health gate (deferred seam — no-op until a runtime implements it) ─
    // Runs BEFORE routes are repointed, so an unhealthy new deployment throws
    // here and the overlap path auto-reverts to the still-running old one.
    if (env.healthCheck) {
      await env.healthCheck(containerId, config);
    }

    // ── Register routes (repoint traffic to the new deployment) ───────
    const routeTarget = env.resolveRoute
      ? await env.resolveRoute(containerId, config)
      : env.resolveTargetUrl
        ? await env.resolveTargetUrl(containerId, config.port).then((targetUrl) => targetUrl ? { targetUrl } : null)
        : null;
    const routeTargetsByPort = env.resolveTargetUrl
      ? new Map<number, Omit<RouteConfig, "domain" | "tls">>()
      : undefined;

    if (env.resolveTargetUrl && routeTargetsByPort) {
      const uniquePorts = Array.from(
        new Set(domains.map((domain) => domain.targetPort ?? config.port)),
      );

      for (const port of uniquePorts) {
        if (port === config.port && routeTarget) {
          routeTargetsByPort.set(port, routeTarget);
          continue;
        }

        const targetUrl = await env.resolveTargetUrl(containerId, port);
        if (targetUrl) {
          routeTargetsByPort.set(port, { targetUrl });
        }
      }
    }

    // Best-effort: returns per-domain warnings instead of throwing. A routing
    // failure here must NOT fail the deploy — the container is already up + healthy.
    const routeWarnings = await registerResolvedRoutes(
      logger,
      routing,
      ssl,
      domains,
      routeTarget,
      routeTargetsByPort,
      routeOptions,
    );

    // ── Overlap only: now the new one is healthy + routed, stop OLD LAST ─
    // Best-effort, and a no-op when the caller set deactivatePrevious=false
    // (snapshot rollback — archivePreviousDeployment stops+retains it instead).
    if (overlap) {
      await deactivatePrevious();
    }

    logger.step("deploy", "completed", "Deployed successfully");

    return {
      status: "ready",
      containerId,
      url,
      ...(routeWarnings.length ? { routeWarnings } : {}),
    };
  } catch (err) {
    const msg = safeErrorMessage(err);
    const errorCode = err instanceof DeployError ? err.code : undefined;
    const errorDetails = err instanceof DeployError ? err.details : undefined;
    logger.step("deploy", "failed", `Deploy failed: ${msg}`);
    logger.log(`\x1b[1;31mDeploy failed: ${msg}\x1b[0m\n`, "error");

    // Non-overlap auto-revert: the old deployment was stopped before the new
    // one started, so on failure try to restart it (best-effort; the bare
    // release dir was kept by deactivate=stop). Overlap runtimes never stopped
    // the old one pre-success, so there is nothing to restore.
    if (!overlap && previousContainerId && env.reactivatePrevious) {
      try {
        logger.log("Deploy failed — restarting the previous deployment…\n", "warn");
        await env.reactivatePrevious(previousContainerId);
      } catch (revertErr) {
        logger.log(
          `Warning: failed to restart previous deployment: ${safeErrorMessage(revertErr)}\n`,
          "warn",
        );
      }
    }

    return { status: "failed", error: msg, errorCode, errorDetails, containerId: activatedContainerId };
  }
}
