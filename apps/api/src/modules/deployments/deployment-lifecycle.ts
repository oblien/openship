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
import type { DeploymentMeta } from "../../lib/deployment-runtime";
import { notification } from "../../lib/notification-dispatcher";
import { audit } from "../../lib/audit";
import * as sessionManager from "./session-manager";
import type { BuildSessionState } from "./session-manager";
import { failureStatusFor } from "./blocking-errors";
import { sanitizeStorableStrings, sliceWithoutSplittingPair } from "./build-log-sanitize";
import { detectAndStoreFavicon } from "../../lib/favicon-detector";
import {
  markWebmailInstalled,
  mailServerIdFromWebmailSlug,
} from "../mail/webmail/webmail-project.service";

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
export function routeIssuesWarning(issues: string[]): string {
  const detail = issues.join("; ");
  return isEdgeDownMessage(detail)
    ? `The app is deployed and running, but its domains aren't being served: the edge on this ` +
        `server is down. Bring the edge back up, then Retry from the Domains tab: ${detail}`
    : `Some domains aren't routed yet — the app is deployed and running; fix DNS/routing and ` +
        `Retry from the Domains tab: ${detail}`;
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
  settled?: "ready" | "failed" | "cancelled" | "reconciling";
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
): Promise<string | null> {
  const attempts: Array<{ label: string; extra: Partial<NewDeployment> }> = [
    { label: "", extra },
  ];
  const shed = { ...extra };
  for (const key of sheddable) delete shed[key];
  if (Object.keys(shed).length < Object.keys(extra).length) {
    attempts.push({ label: `without ${sheddable.join("/")}`, extra: shed });
  }
  if (Object.keys(shed).length > 0) attempts.push({ label: "status only", extra: {} });

  let lastError = "";
  for (const [index, attempt] of attempts.entries()) {
    try {
      await repos.deployment.updateStatus(depId, status, attempt.extra);
      if (index > 0) {
        console.error(
          `[deployment-lifecycle] ${depId}: recorded "${status}" ${attempt.label} — ` +
            `the rejected payload was dropped: ${lastError}`,
        );
      }
      return null;
    } catch (err) {
      lastError = safeErrorMessage(err);
    }
  }
  console.error(
    `[deployment-lifecycle] ${depId}: could not record outcome "${status}": ${lastError}`,
  );
  return lastError;
}

export async function cleanupBuildArtifact(
  runtime: RuntimeAdapter,
  artifactRef: string,
): Promise<void> {
  // An absolute-path ref is a filesystem build DIRECTORY (a bare build dir, or a
  // static Docker build's extracted doc-root at STATIC_RELEASE_BASE/.builds/…),
  // NOT a docker image. (Image tags contain "/" but never START with it.)
  // removeImage would 404-no-op on a path and leak the dir, so remove it as a
  // directory — destroy() rm's an absolute path on both runtimes.
  if (artifactRef.startsWith("/")) {
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
      };
    };
  },
): Promise<void> {
  await repos.deployment.updateStatus(deploymentId, dbStatus, opts?.extra);
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
      console.error(
        `[DEPLOY] Failed to destroy ${provisioned.imageRef} on failure:`,
        destroyErr,
      );
      // Retry once after a short delay
      await new Promise((r) => setTimeout(r, 2000));
      await cleanupBuildArtifact(runtime, provisioned.imageRef).catch((retryErr) => {
        console.error(
          `[DEPLOY] Retry destroy also failed for ${provisioned.imageRef}:`,
          retryErr,
        );
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
  await recordOutcome(
    dep.id,
    dbStatus,
    {
      errorMessage,
      errorCode: errorMeta?.errorCode ?? null,
      errorDetails: sanitizeStorableStrings(errorMeta?.errorDetails) ?? null,
    },
    ["errorDetails"],
  );
  ctx.settled = "failed";
  await finishSession(buildSessionId, "failed", durationMs ?? 0, collapsed);
  sessionManager.updateStatus(dep.id, "failed", {
    ...errorMeta,
    errorMessage,
  });

  // Notify — dispatch to every subscribed channel (per-user prefs +
  // org defaults). Fire-and-forget: the dispatcher fans out across
  // email/webhook/in-app/slack based on each member's subscriptions.
  const lastLogs = collapsed.slice(-50).map((l) => l.message).join("\n");
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

export async function onCancelled(
  ctx: LifecycleContext,
  durationMs?: number,
): Promise<void> {
  const { runtime, dep, buildSessionId, provisioned } = ctx;

  if (runtime && provisioned.imageRef) {
    try {
      await cleanupBuildArtifact(runtime, provisioned.imageRef);
    } catch (destroyErr) {
      console.error(
        `[DEPLOY] Failed to destroy ${provisioned.imageRef} on cancel:`,
        destroyErr,
      );
      await new Promise((r) => setTimeout(r, 2000));
      await cleanupBuildArtifact(runtime, provisioned.imageRef).catch(() => {});
    }
  }

  // Destroy service containers and broadcast failed status (mirrors onFailure)
  const serviceDeps = await repos.service.listByDeployment(dep.id).catch(() => []);
  const services = serviceDeps.length > 0
    ? await repos.service.listByProject(dep.projectId).catch(() => [])
    : [];
  const serviceNameMap = new Map(services.map((s) => [s.id, s.name]));

  for (const serviceDep of serviceDeps) {
    if (runtime && serviceDep.containerId) {
      await runtime.destroy(serviceDep.containerId).catch((err) => {
        console.error(`[DEPLOY] Failed to destroy service container ${serviceDep.containerId} on cancel:`, err);
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

  const outcomeError = await recordOutcome(
    dep.id,
    "ready",
    { errorMessage: null, meta: mergedMeta, version },
    ["meta"],
  );

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

  // Webmail: flip mail-state `installed=true` so the /emails Open-webmail
  // CTA can finally surface. Slug is the only carrier of mailServerId
  // through the generic lifecycle - preserved by `ensureWebmailProject`.
  // For cloud deploys we also pass `result.url` so the success hook can
  // register an OpenResty proxy on the mail VPS pointing mail.<install>
  // → opsh.io (when that's the chosen hostname).
  if (project.framework === "webmail") {
    const mailServerId = mailServerIdFromWebmailSlug(project.slug);
    if (mailServerId) void markWebmailInstalled(mailServerId, project.organizationId, result.url);
  }
}
