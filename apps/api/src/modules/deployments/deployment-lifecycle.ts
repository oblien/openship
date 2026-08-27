/**
 * Deployment lifecycle hooks - shared onSuccess / onFailure for the
 * entire build→deploy process.
 *
 * The orchestrator (build.service.ts) creates a lifecycle context once
 * at the start of a deployment, then calls onSuccess or onFailure at
 * the end. These hooks handle everything:
 *
 *   onFailure  →  destroy resources → mark DB failed → finish session → SSE → notify
 *   onSuccess  →  persist container → mark DB ready → finish session → SSE → notify
 *
 * This keeps the orchestrator focused on sequencing (build → deploy)
 * while all side-effects on completion live here.
 */

import { repos, type Project, type Deployment, type NewDeployment } from "@repo/db";
import { DockerRuntime, isEdgeDownMessage, type BuildLogger, type LogEntry } from "@repo/adapters";
import type { RuntimeAdapter } from "@repo/adapters";
import { SYSTEM, safeErrorMessage } from "@repo/core";
import { env } from "../../config";
import { isArtifactRef } from "../../lib/container-ref";
import type { DeploymentMeta } from "../../lib/deployment-runtime";
import { notification } from "../../lib/notification-dispatcher";
import { audit } from "../../lib/audit";
import * as sessionManager from "./session-manager";
import type { BuildSessionState } from "./session-manager";
import { failureStatusFor } from "./blocking-errors";
import { sanitizeStorableStrings, sliceWithoutSplittingPair } from "./build-log-sanitize";
import { detectAndStoreFavicon } from "../../lib/favicon-detector";
import { onWebmailDeployed } from "../mail/webmail/webmail-install.service";

/**
 * The "your domains didn't route" line for a deploy that otherwise succeeded.
 *
 * Shared by both pipelines (single-app and compose) so the two can't drift — they
 * feed the same `edgeUnsynced` → "Action Required" + Retry signal, so they must not
 * disagree about what to tell the operator to do.
 *
 * The advice BRANCHES, and that's the point: "fix DNS/routing and Retry" is the right
 * answer for a domain that doesn't resolve here, and actively misleading when the
 * edge container itself is down — the routes are fine, nothing is serving them, and
 * Retry cannot succeed until the edge starts. Sending an operator to their DNS
 * provider over a crash-looping OpenResty costs them the whole debugging session.
 */
export function routeIssuesWarning(issues: string[], tlsPending: string[] = []): string {
  const parts: string[] = [];
  if (issues.length > 0) {
    const detail = issues.join("; ");
    parts.push(
      isEdgeDownMessage(detail)
        ? `The app is deployed and running, but its domains aren't being served: the edge on this ` +
            `server is down. Bring the edge back up, then Retry from the Domains tab: ${detail}`
        : `Some domains aren't routed yet — the app is deployed and running; fix DNS/routing and ` +
            `Retry from the Domains tab: ${detail}`,
    );
  }
  // A DIFFERENT outcome with a DIFFERENT remedy, which is why it gets its own
  // sentence rather than joining the list above: these hostnames ARE routed (the
  // vhost exists and answers on :80), they just have no certificate, so HTTPS is
  // served by the edge's bootstrap self-signed cert. "Fix routing and retry" would
  // send the operator after the wrong thing — the fix is DNS + Verify.
  if (tlsPending.length > 0) {
    parts.push(
      `${tlsPending.length} domain${tlsPending.length === 1 ? " is" : "s are"} routed but ` +
        `${tlsPending.length === 1 ? "has" : "have"} no HTTPS certificate yet — point DNS at this ` +
        `server, then Verify from the Domains tab: ${tlsPending.join("; ")}`,
    );
  }
  return parts.join(" · ");
}

export interface LifecycleContext {
  /**
   * Optional - runtime is only touched when cleanup of a provisioned
   * image or service container is needed. Bespoke pipelines (e.g.
   * webmail) that don't go through `runtime.build` can omit it.
   */
  runtime?: RuntimeAdapter;
  project: Project;
  dep: Deployment;
  buildSessionId: string;
  /** Returns collapsed logs for DB persistence. */
  persistLogs: () => LogEntry[];
  /** Provisioned resources - set by the orchestrator as phases progress. */
  provisioned: { imageRef?: string };
  /**
   * Set by the terminal hooks below the moment the DEPLOYMENT ROW carries its
   * outcome. The pipeline's outer catch reads it: anything thrown afterwards (a
   * post-deploy step, the log-persistence write itself) must NOT be re-reported
   * through onFailure — that inverts a working deploy and tears down its
   * containers.
   */
  settled?: "ready" | "failed" | "cancelled" | "reconciling" | "no_changes";
}

/** Build the persistable log array. Collapsing/sanitizing it is observability
 *  work, so a crash in it degrades to a one-line explanation, never a failure. */
function collectLogs(ctx: LifecycleContext): LogEntry[] {
  try {
    return ctx.persistLogs();
  } catch (err) {
    const detail = safeErrorMessage(err);
    console.error(`[deployment-lifecycle] persistLogs crashed for ${ctx.dep.id}: ${detail}`);
    return [
      {
        timestamp: new Date().toISOString(),
        message: `Build logs could not be prepared for storage: ${detail}`,
        level: "error",
      },
    ];
  }
}

/**
 * Persisting the build log is OBSERVABILITY; the deployment's outcome is truth.
 * A throw here (a jsonb-hostile log payload, a dead connection) used to escape
 * onSuccess into the pipeline's outer catch, which re-ran onFailure — recording
 * a working deploy as failed AND skipping the SSE terminal event that follows
 * every call, so the deploy header stayed on "Deploying" forever.
 */
async function finishSession(
  buildSessionId: string,
  status: string,
  durationMs: number,
  logs?: LogEntry[],
): Promise<void> {
  await repos.deployment
    .finishBuildSession(buildSessionId, status, durationMs, logs)
    .catch((err) =>
      console.error(
        `[deployment-lifecycle] finishBuildSession(${buildSessionId}, ${status}) failed — ` +
          `deployment outcome unchanged: ${safeErrorMessage(err)}`,
      ),
    );
}

/**
 * What the pipeline's outer catch does with an error.
 *
 * It sees two very different things: a real build/deploy failure, and an error
 * thrown AFTER a terminal hook already recorded the outcome (a post-deploy step,
 * the log-persistence write itself). Re-reporting the second through onFailure
 * inverts a working deploy and destroys the image plus every service container
 * that had just come up, so it degrades to a warning on the live stream.
 *
 * Lives here rather than inline in build-pipeline so the decision is exercisable
 * without standing up the whole build platform.
 */
export async function reportPipelineError(
  ctx: LifecycleContext,
  message: string,
  logger: Pick<BuildLogger, "log">,
): Promise<void> {
  if (ctx.settled) {
    console.warn(
      `[build] post-settlement error for ${ctx.dep.id} (outcome ${ctx.settled} kept): ${message}`,
    );
    logger.log(
      `Warning: a step after the deployment was recorded ${ctx.settled} failed: ${message}\n`,
      "warn",
    );
    return;
  }
  logger.log(`Error: ${message}`, "error");
  await onFailure(ctx, message);
}

function truncateError(msg: string): string {
  const max = SYSTEM.DEPLOYMENTS.MAX_ERROR_MESSAGE_LENGTH;
  // Sanitized because the error text is raw process output too, and a NUL kills
  // a plain text column ("invalid byte sequence for encoding UTF8: 0x00") just
  // as it kills jsonb. Cut on a code-point boundary for the same reason the log
  // cap does — a half-emoji here would be copied verbatim into an SSE frame and
  // a notification payload.
  const clean = sanitizeStorableStrings(msg);
  return clean.length > max ? sliceWithoutSplittingPair(clean, max) + "…" : clean;
}

/**
 * Write a terminal outcome onto the deployment row.
 *
 * The status IS the record. The jsonb blobs riding along with it (`meta`,
 * `errorDetails`) are observability, assembled partly from user data — a compose
 * env value long enough to hit the per-entry cap, raw process output from a
 * failed prepare step — and Postgres rejects the WHOLE statement over one bad
 * byte in them. An unguarded write therefore threw out of onSuccess, the
 * pipeline read the throw as a deploy failure, and every container that had just
 * come up was destroyed. So the blobs are SHED and the write retried; the
 * outcome never depends on them.
 *
 * Never throws. A status write that cannot land at all must not strand the
 * stream either — the caller's terminal SSE event is what closes it, and a
 * deploy whose `complete` never arrives sits on "Deploying" with nothing coming
 * to correct it. Returns the DB error when the row does NOT carry the outcome,
 * so the caller can surface it, or null on success.
 */
async function recordOutcome(
  depId: string,
  status: string,
  extra: Partial<NewDeployment>,
  sheddable: ReadonlyArray<keyof NewDeployment> = [],
): Promise<{ state: "applied" | "refused" | "failed"; error: string | null }> {
  const attempts: Array<{ label: string; extra: Partial<NewDeployment> }> = [{ label: "", extra }];
  const shed = { ...extra };
  for (const key of sheddable) delete shed[key];
  if (Object.keys(shed).length < Object.keys(extra).length) {
    attempts.push({ label: `without ${sheddable.join("/")}`, extra: shed });
  }
  if (Object.keys(shed).length > 0) attempts.push({ label: "status only", extra: {} });

  let lastError = "";
  for (const [index, attempt] of attempts.entries()) {
    try {
      const applied = await repos.deployment.updateStatus(depId, status, attempt.extra);
      if (index > 0) {
        console.error(
          `[deployment-lifecycle] ${depId}: recorded "${status}" ${attempt.label} — ` +
            `the rejected payload was dropped: ${lastError}`,
        );
      }
      // ONLY an explicit `false` is a refusal (the row is already cancelled).
      // Inferring one from any falsy return would turn a successful deploy into a
      // cancelled one the moment a caller's stub — or a future impl — returns
      // nothing. "refused" suppresses the success; "failed" must not.
      return { state: applied === false ? "refused" : "applied", error: null };
    } catch (err) {
      lastError = safeErrorMessage(err);
    }
  }
  console.error(
    `[deployment-lifecycle] ${depId}: could not record outcome "${status}": ${lastError}`,
  );
  // The write failed outright. The deploy still SUCCEEDED, so the caller reports
  // ready with an explanation rather than inverting a working deploy.
  return { state: "failed", error: lastError };
}

export async function cleanupBuildArtifact(
  runtime: RuntimeAdapter,
  artifactRef: string,
): Promise<void> {
  // An absolute-path ref is a filesystem build DIRECTORY (a bare build dir, or a
  // static Docker build's extracted doc-root at STATIC_RELEASE_BASE/.builds/…),
  // NOT a docker image. removeImage would fail on a path and leak the dir, so
  // remove it as a directory — destroy() rm's an absolute path on both runtimes.
  // The rule itself lives in `isArtifactRef`, shared with the teardown collector
  // that used to open-code the opposite answer (issue #640).
  if (isArtifactRef(artifactRef)) {
    await runtime.destroy(artifactRef);
    return;
  }
  if (runtime instanceof DockerRuntime) {
    await runtime.removeImage(artifactRef);
    return;
  }

  await runtime.destroy(artifactRef);
}

/**
 * Set a deployment's status on BOTH layers in one call: the DB row
 * (repos.deployment.updateStatus) and the in-memory SSE session
 * (sessionManager.updateStatus). Every non-terminal transition needs
 * both, and they were previously hand-written at each call site.
 *
 * The SSE layer only knows the legacy statuses, so for a DB-only status
 * (e.g. "partial_failure") pass an explicit `sse.status` (typically
 * "ready" + a warningMessage); otherwise the SSE status mirrors the DB
 * status.
 *
 * NOTE: terminal completion (ready/failed/cancelled) is owned by
 * onSuccess/onFailure/onCancelled — use those, not this helper.
 */
export async function setDeploymentStatus(
  deploymentId: string,
  dbStatus: string,
  opts?: {
    extra?: Partial<NewDeployment>;
    sse?: {
      status?: BuildSessionState["status"];
      meta?: {
        errorCode?: string;
        errorDetails?: Record<string, unknown>;
        warningMessage?: string;
        errorMessage?: string;
        /**
         * A keep/reject decision is being HELD for this deployment (a partial failure).
         *
         * Sent explicitly because it is not derivable from anything else on the event. The client
         * used to infer it from "there is a warningMessage and the deploy succeeded", which is
         * true of a partial failure and also of every routing/TLS advisory on a perfectly
         * successful deploy — so a project whose domains had no cert yet was shown "Deployment
         * finished with failed services · 0 of 5 services failed".
         */
        decisionPending?: boolean;
      };
    };
  },
): Promise<void> {
  const applied = await repos.deployment.updateStatus(deploymentId, dbStatus, opts?.extra);
  // An explicit `false` means the row is already cancelled and stayed that way.
  // Broadcasting anyway would tell the UI the deploy the user stopped is still
  // moving. Any other return counts as applied — see recordOutcome.
  if (applied === false) return;
  sessionManager.updateStatus(
    deploymentId,
    opts?.sse?.status ?? (dbStatus as BuildSessionState["status"]),
    opts?.sse?.meta,
  );
}

/**
 * INDETERMINATE completion: the connection to the server dropped after
 * container(s) started, so we can neither confirm success nor declare failure.
 *
 * Persist `reconciling` and finish the build stream — but, unlike onFailure,
 * DO NOT destroy the build artifact or the service containers (they may be
 * running perfectly) and DO NOT advance the project's active pointer
 * (forward-only: only a confirmed success advances it). A later
 * `reconcileDeployment` reads the true remote state and settles this to
 * ready / partial_failure / failed.
 */
export async function onReconciling(
  ctx: LifecycleContext,
  result: { containerId?: string; warningMessage?: string; durationMs?: number },
): Promise<void> {
  const { dep, buildSessionId } = ctx;

  if (result.containerId) {
    await repos.deployment.setContainerId(dep.id, result.containerId).catch(() => {});
  }

  const collapsed = collectLogs(ctx);
  await recordOutcome(dep.id, "reconciling", { errorMessage: null });
  ctx.settled = "reconciling";
  // The build stream is finished; the SSE layer has no "reconciling", so close
  // it as "ready" with a warning. The dashboard reads the DB row's `reconciling`
  // status for the actual state (same split as partial_failure).
  await finishSession(buildSessionId, "ready", result.durationMs ?? 0, collapsed);
  sessionManager.updateStatus(dep.id, "ready", {
    warningMessage:
      result.warningMessage ?? "Connection lost during deploy — verifying remote state.",
  });
}

/**
 * NO-OP completion: a compose deploy that carried EVERY service forward, so it
 * built, created and probed nothing (`composeDeployMadeNoChanges`).
 *
 * Like onReconciling and unlike onSuccess: does NOT advance the active pointer and
 * does NOT record a container. The CURRENT active deployment still owns the live
 * containers and the image they run; this row owns nothing, so promoting it would
 * make an empty release the newest `ready` one and a rollback target.
 *
 * Tears nothing down, deliberately: `onFailure` and `onCancelled` both destroy the
 * deployment's service containers, and the containers listed under THIS row are
 * the ones still serving.
 */
export async function onNoChanges(
  ctx: LifecycleContext,
  result: { warningMessage?: string; durationMs?: number },
): Promise<void> {
  const { project, buildSessionId, dep } = ctx;

  const collapsed = collectLogs(ctx);
  const reason =
    result.warningMessage ??
    "No changes to deploy — every service was already up to date, so the current release stayed live.";
  // Under `composeDeployment.warningMessage` because that is where the build-status
  // refresh path reads a persisted deploy note from. Sanitized like onSuccess's
  // meta — a NUL in the reason must not fail the write.
  const previousMeta = (dep.meta as DeploymentMeta | null) ?? {};
  const mergedMeta = sanitizeStorableStrings({
    ...previousMeta,
    composeDeployment: { ...(previousMeta.composeDeployment ?? {}), warningMessage: reason },
  });
  await recordOutcome(dep.id, "no_changes", { errorMessage: null, meta: mergedMeta }, ["meta"]);
  ctx.settled = "no_changes";
  // The SSE layer has no third terminal state, so the stream closes "ready" and
  // the dashboard reads `no_changes` off the row (same split as onReconciling).
  await finishSession(buildSessionId, "ready", result.durationMs ?? 0, collapsed);
  sessionManager.updateStatus(dep.id, "ready", { warningMessage: reason });

  notification.emit({
    organizationId: dep.organizationId,
    eventType: "deployment.no_changes",
    resourceType: "deployment",
    resourceId: dep.id,
    payload: {
      projectName: project.name,
      branch: dep.branch,
      commitSha: dep.commitSha,
      durationMs: result.durationMs,
      message: reason,
    },
  });

  audit.recordAsync(
    { organizationId: dep.organizationId, actorUserId: null, source: "system" },
    {
      eventType: "deployment.no_changes",
      resourceType: "deployment",
      resourceId: dep.id,
      before: { status: dep.status },
      after: {
        status: "no_changes",
        projectId: project.id,
        branch: dep.branch,
        commitSha: dep.commitSha,
        durationMs: result.durationMs,
      },
    },
  );
}

export async function onFailure(
  ctx: LifecycleContext,
  error?: string,
  durationMs?: number,
  errorMeta?: { errorCode?: string; errorDetails?: Record<string, unknown>; errorMessage?: string },
): Promise<void> {
  const { runtime, project, dep, buildSessionId, provisioned } = ctx;

  // Always delete the workspace/container on failure so the user doesn't
  // have to manually clean up.
  if (runtime && provisioned.imageRef) {
    try {
      await cleanupBuildArtifact(runtime, provisioned.imageRef);
    } catch (destroyErr) {
      console.error(`[DEPLOY] Failed to destroy ${provisioned.imageRef} on failure:`, destroyErr);
      // Retry once after a short delay
      await new Promise((r) => setTimeout(r, 2000));
      await cleanupBuildArtifact(runtime, provisioned.imageRef).catch((retryErr) => {
        console.error(`[DEPLOY] Retry destroy also failed for ${provisioned.imageRef}:`, retryErr);
      });
    }
  }

  if (runtime) {
    const serviceDeps = await repos.service.listByDeployment(dep.id).catch(() => []);
    for (const serviceDep of serviceDeps) {
      if (!serviceDep.containerId) continue;
      try {
        await runtime.destroy(serviceDep.containerId);
      } catch (destroyErr) {
        console.error(
          `[DEPLOY] Failed to destroy service container ${serviceDep.containerId} on failure:`,
          destroyErr,
        );
      }
    }
  }

  // INVARIANT: failure writes the DEPLOYMENT row only — NEVER the project row.
  // The project's live-release pointer (activeDeploymentId) advances solely on
  // success (onSuccess) so a failed deploy has zero effect on the project's
  // live state. Do not add a setActiveDeployment call here.
  const errorMessage = error ? truncateError(error) : undefined;
  const collapsed = collectLogs(ctx);
  // PERSIST the classification, not just the prose. The code + details used to
  // reach the in-memory session only, so a restart left the row saying "Port 3000
  // is already in use by …" with no machine-readable cause, no pid, and nothing
  // able to offer a fix. See migration 0080.
  //
  // A code with a resolution the operator can carry out is persisted as
  // `action_required` (failureStatusFor). That is a DB-ONLY distinction — the SSE
  // session below is always told `failed`, because "ready|failed|cancelled" is
  // what closes the stream (session-manager). Same split as `partial_failure`.
  const dbStatus = failureStatusFor(errorMeta?.errorCode);
  const outcome = await recordOutcome(
    dep.id,
    dbStatus,
    {
      errorMessage,
      errorCode: errorMeta?.errorCode ?? null,
      errorDetails: sanitizeStorableStrings(errorMeta?.errorDetails) ?? null,
    },
    ["errorDetails"],
  );

  // The row refused the write because it is already cancelled: the user stopped
  // this deploy mid-flight and the pipeline then failed under its own teardown.
  // The cancel is the truth. Broadcasting `failed` over it anyway is what let a
  // stopped install report itself as a failure — the row said `cancelled` while
  // the stream said `failed`, so the wizard flagged a neutral cancel AND took the
  // failure message, and printed "Install failed" under "Install cancelled".
  //
  // cancelBuildSession has already torn down what it provisioned and already
  // broadcast `cancelled`, so settle the session as cancelled and emit nothing
  // further: no second terminal event, and no `deployment.failed` notification
  // for a deploy the user ended on purpose. Mirrors the guard in onSuccess.
  if (outcome.state === "refused") {
    console.warn(
      `[deployment-lifecycle] ${dep.id}: deploy failed after the user cancelled it; ` +
        `leaving the row cancelled and reporting the cancel rather than a failure`,
    );
    ctx.settled = "cancelled";
    await finishSession(buildSessionId, "cancelled", durationMs ?? 0, collapsed);
    return;
  }

  ctx.settled = "failed";
  await finishSession(buildSessionId, "failed", durationMs ?? 0, collapsed);
  sessionManager.updateStatus(dep.id, "failed", {
    ...errorMeta,
    errorMessage,
  });

  // Notify — dispatch to every subscribed channel (per-user prefs +
  // org defaults). Fire-and-forget: the dispatcher fans out across
  // email/webhook/in-app/slack based on each member's subscriptions.
  const lastLogs = collapsed
    .slice(-50)
    .map((l) => l.message)
    .join("\n");
  notification.emit({
    organizationId: dep.organizationId,
    eventType: "deployment.failed",
    resourceType: "deployment",
    resourceId: dep.id,
    payload: {
      projectName: project.name,
      branch: dep.branch,
      commitSha: dep.commitSha,
      errorMessage: errorMessage ?? "Unknown error",
      // The classified cause rides along so a webhook/Slack consumer can branch
      // on it instead of parsing the message. Still emitted for
      // `action_required` — that deploy DID fail, and anything watching failures
      // must not go blind just because we can also offer a fix.
      errorCode: errorMeta?.errorCode,
      logsTail: lastLogs,
      durationMs,
    },
  });

  // Audit — async fire-and-forget; never blocks the failure path.
  // actorUserId is null here because the lifecycle runs in background;
  // the user who triggered the deploy is recorded on the original
  // `deployment.created` audit_event row.
  audit.recordAsync(
    { organizationId: dep.organizationId, actorUserId: null, source: "system" },
    {
      eventType: "deployment.failed",
      resourceType: "deployment",
      resourceId: dep.id,
      before: { status: dep.status },
      after: {
        status: dbStatus,
        projectId: project.id,
        branch: dep.branch,
        commitSha: dep.commitSha,
        errorMessage,
        errorCode: errorMeta?.errorCode,
        durationMs,
      },
    },
  );
}

export async function onCancelled(ctx: LifecycleContext, durationMs?: number): Promise<void> {
  const { runtime, dep, buildSessionId, provisioned } = ctx;

  if (runtime && provisioned.imageRef) {
    try {
      await cleanupBuildArtifact(runtime, provisioned.imageRef);
    } catch (destroyErr) {
      console.error(`[DEPLOY] Failed to destroy ${provisioned.imageRef} on cancel:`, destroyErr);
      await new Promise((r) => setTimeout(r, 2000));
      await cleanupBuildArtifact(runtime, provisioned.imageRef).catch(() => {});
    }
  }

  // Destroy service containers and broadcast failed status (mirrors onFailure)
  const serviceDeps = await repos.service.listByDeployment(dep.id).catch(() => []);
  const services =
    serviceDeps.length > 0 ? await repos.service.listByProject(dep.projectId).catch(() => []) : [];
  const serviceNameMap = new Map(services.map((s) => [s.id, s.name]));

  for (const serviceDep of serviceDeps) {
    if (runtime && serviceDep.containerId) {
      await runtime.destroy(serviceDep.containerId).catch((err) => {
        console.error(
          `[DEPLOY] Failed to destroy service container ${serviceDep.containerId} on cancel:`,
          err,
        );
      });
    }
    sessionManager.broadcastServiceStatus(dep.id, {
      serviceName: serviceNameMap.get(serviceDep.serviceId) ?? serviceDep.serviceId,
      serviceId: serviceDep.serviceId,
      status: "failed",
      error: "Deployment cancelled",
    });
  }

  // INVARIANT: cancel writes the DEPLOYMENT row only — NEVER the project row.
  // A cancelled redeploy leaves activeDeploymentId (the last successful release)
  // exactly as it was. Do not add a setActiveDeployment call here.
  await recordOutcome(dep.id, "cancelled", {});
  ctx.settled = "cancelled";
  await finishSession(buildSessionId, "cancelled", durationMs ?? 0, collectLogs(ctx));
  sessionManager.updateStatus(dep.id, "cancelled");

  notification.emit({
    organizationId: dep.organizationId,
    eventType: "deployment.cancelled",
    resourceType: "deployment",
    resourceId: dep.id,
    payload: {
      projectName: ctx.project.name,
      branch: dep.branch,
      commitSha: dep.commitSha,
      durationMs,
    },
  });
}

/** Release numbering is cosmetic — see the call site's ordering invariant. */
async function readReleaseVersion(
  projectId: string,
  commitSha: string | null | undefined,
): Promise<number | undefined> {
  try {
    return (
      (await repos.deployment.findReadyVersionByCommit(projectId, commitSha)) ??
      (await repos.deployment.getNextReadyVersion(projectId))
    );
  } catch (err) {
    console.error(
      `[deployment-lifecycle] release version lookup failed project=${projectId}: ${safeErrorMessage(err)} — release left unnumbered`,
    );
    return undefined;
  }
}

export async function onSuccess(
  ctx: LifecycleContext,
  result: {
    containerId: string;
    url?: string;
    durationMs: number;
    warningMessage?: string;
    metaPatch?: Record<string, unknown>;
  },
): Promise<void> {
  const { project, dep, buildSessionId } = ctx;

  // ORDERING INVARIANT: the workload is already up, so NOTHING between here and
  // `ctx.settled = "ready"` below may throw. The pipeline's outer catch reads an
  // unsettled throw as a deploy failure and runs onFailure, which destroys the
  // build artifact and every service container that had just started. So each
  // step down to the settlement line is either the outcome write itself
  // (shed-and-retry, never throws) or explicitly best-effort.
  await repos.deployment
    .setContainerId(dep.id, result.containerId, result.url)
    .catch((err) =>
      console.error(
        `[deployment-lifecycle] setContainerId failed deployment=${dep.id} container=${result.containerId}: ${safeErrorMessage(err)}`,
      ),
    );

  // Sanitized: metaPatch carries service/routing warnings built from raw process
  // output, and `meta` is jsonb written BEFORE the outcome — one NUL in a warning
  // string would fail the "ready" write and take the whole deploy down with it.
  const mergedMeta = sanitizeStorableStrings(
    result.metaPatch
      ? { ...((dep.meta as DeploymentMeta | null) ?? {}), ...result.metaPatch }
      : ((dep.meta as DeploymentMeta | null) ?? null),
  );

  // Assign the human-friendly version NOW, on success — not at create. A version
  // is a shipped release: only successful deploys get one, and it's per-commit
  // (redeploying the same commit reuses its number rather than burning a new
  // one). The one-in-flight-per-project index serializes deploys, so the
  // MAX(ready)+1 fallback can't race.
  //
  // The number is COSMETIC: a transient read failure leaves the release
  // unnumbered (drizzle omits an undefined column) rather than tearing down a
  // deploy that worked.
  const version = await readReleaseVersion(project.id, dep.commitSha);

  const outcome = await recordOutcome(
    dep.id,
    "ready",
    { errorMessage: null, meta: mergedMeta, version },
    ["meta"],
  );
  const outcomeError = outcome.error;

  // The row refused the write because it is already cancelled: the user stopped
  // this deploy while it was in the deploy phase, which is not cancellable, so it
  // ran to completion anyway. Everything below publishes a SUCCESS — the active
  // release pointer above all — and none of it may happen for a deployment that
  // was cancelled. cancelBuildSession already tore down what it provisioned and
  // already broadcast `cancelled`, so this returns silently rather than emitting
  // a second terminal event.
  if (outcome.state === "refused") {
    console.warn(
      `[deployment-lifecycle] ${dep.id}: deploy finished after the user cancelled it; ` +
        `leaving the row cancelled and NOT advancing the active release`,
    );
    ctx.settled = "cancelled";
    await finishSession(buildSessionId, "cancelled", result.durationMs, collectLogs(ctx));
    return;
  }

  // From here the deployment ROW says ready: the outcome is recorded, so
  // nothing below may be allowed to turn it into a failure.
  ctx.settled = "ready";

  // Everything from here down is bookkeeping around an outcome that is already
  // recorded, so each step is best-effort with a loud server-side log. Nothing
  // in this tail may throw: it would skip the terminal SSE event below, and a
  // deploy whose `complete` never arrives sits on "Deploying" forever with
  // nothing ever coming to correct it.
  await repos.project
    .setActiveDeployment(project.id, dep.id)
    .catch((err) =>
      console.error(
        `[deployment-lifecycle] setActiveDeployment failed project=${project.id} deployment=${dep.id}: ${safeErrorMessage(err)}`,
      ),
    );

  // A newer release makes a prior held keep/reject decision moot — mark it
  // superseded so no stale deployment reads as "Action Required". Best-effort.
  await repos.deployment
    .supersedePendingDecisions(project.id, dep.id)
    .catch((err) =>
      console.warn(
        `[deployment-lifecycle] supersedePendingDecisions failed project=${project.id}: ${safeErrorMessage(err)}`,
      ),
    );

  // deployment.meta is the per-deploy historical snapshot; the
  // project column is the CURRENT cloud binding. Drift detection
  // reads the project column.
  //
  // EXCEPT for a local-orchestrated cloud deploy (self-hosted instance,
  // deployTarget=cloud + buildStrategy=local): the project MUST stay
  // local-canonical. `cloud_workspace_id` is the "this project lives on
  // the SaaS — proxy everything to it" primitive; setting it here would
  // flip the project to a SaaS proxy and break the next local build. The
  // workspace is still tracked per-deploy via `deployment.containerId`
  // (used for retirement of the previous workspace on redeploy), so
  // skipping the project column here loses nothing for this mode.
  const isLocalOrchestratedCloud =
    !env.CLOUD_MODE &&
    mergedMeta?.deployTarget === "cloud" &&
    mergedMeta?.buildStrategy === "local";
  if (mergedMeta?.workspaceId && !isLocalOrchestratedCloud) {
    await repos.project
      .setCloudWorkspaceId(project.id, mergedMeta.workspaceId)
      .catch((err) =>
        console.warn(
          `[deployment-lifecycle] setCloudWorkspaceId failed project=${project.id} workspace=${mergedMeta.workspaceId}: ${safeErrorMessage(err)}`,
        ),
      );
  }

  // Persist the DURABLE server binding (self-hosted). deployment.meta.serverId is
  // the per-deploy snapshot; project.server_id is the current owner that
  // resolveSnapshotTarget reads FIRST, so a later fresh/partial redeploy stays on
  // the server instead of falling back to "local". Best-effort + idempotent; we
  // never CLEAR it on a local deploy (a wrong-local resolve must not silently
  // unbind) — unbinding happens via explicit retarget or FK ON DELETE SET NULL.
  if (
    mergedMeta?.serverId &&
    mergedMeta.deployTarget !== "cloud" &&
    project.serverId !== mergedMeta.serverId
  ) {
    await repos.project
      .update(project.id, { serverId: mergedMeta.serverId })
      .catch((err) =>
        console.warn(
          `[deployment-lifecycle] persist server binding failed project=${project.id} server=${mergedMeta.serverId}: ${safeErrorMessage(err)}`,
        ),
      );
  }

  await finishSession(buildSessionId, "ready", result.durationMs, collectLogs(ctx));
  sessionManager.updateStatus(dep.id, "ready", {
    // The deploy WORKED whether or not the row took the write, and the terminal
    // event has to go out either way — but say so, because the row the dashboard
    // re-reads on refresh may still say "deploying".
    warningMessage: outcomeError
      ? [
          result.warningMessage,
          `The deploy succeeded but recording it failed (${outcomeError}); the deployment record may be out of date.`,
        ]
          .filter(Boolean)
          .join(" ")
      : result.warningMessage,
    // Advisory port-check results ride the live `complete` event so the dashboard
    // can raise the "wrong port?" modal immediately; the same data is persisted in
    // meta (above) for re-hydration on refresh.
    portCheck: (mergedMeta as DeploymentMeta | null)?.portCheck ?? undefined,
  });

  notification.emit({
    organizationId: dep.organizationId,
    eventType: "deployment.succeeded",
    resourceType: "deployment",
    resourceId: dep.id,
    payload: {
      projectName: project.name,
      branch: dep.branch,
      commitSha: dep.commitSha,
      url: result.url,
      durationMs: result.durationMs,
    },
  });

  // Audit — async fire-and-forget. actorUserId null; the trigger
  // attribution lives on the original `deployment.created` row.
  // Records BOTH before and after for state transitions so an auditor
  // can see exactly what changed without joining the deployment table.
  audit.recordAsync(
    { organizationId: dep.organizationId, actorUserId: null, source: "system" },
    {
      eventType: "deployment.succeeded",
      resourceType: "deployment",
      resourceId: dep.id,
      before: { status: dep.status },
      after: {
        status: "ready",
        projectId: project.id,
        branch: dep.branch,
        commitSha: dep.commitSha,
        url: result.url,
        durationMs: result.durationMs,
      },
    },
  );

  // Async favicon detection - don't block the deploy response
  if (result.url) {
    void detectAndStoreFavicon(project.id, result.url);
  }

  // Webmail on Openship Cloud, routed on the mail server's own `mail.<domain>`:
  // the mail VPS proxies that hostname to the cloud URL, which can only be
  // registered once the URL exists. Await it so the deployment execution lease
  // brackets this remote route/certificate write; otherwise project deletion
  // could observe a finished worker, remove the route, and have this detached
  // hook recreate it afterwards. The hook catches/logs its own failures and
  // returns immediately for every non-webmail deploy.
  await onWebmailDeployed(project, result.url);
}
