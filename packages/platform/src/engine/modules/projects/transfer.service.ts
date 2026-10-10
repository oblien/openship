/**
 * Project transfer service — local <-> Openship Cloud mobility.
 *
 * Thin wrapper around dumpSubgraph / restoreSubgraph + the unified
 * cloudClient.{ingestSubgraph,exportSubgraph} primitives. Both directions:
 *
 *   transferProjectToCloud      — PROMOTE: dump local project subgraph, push to
 *                                 SaaS (which becomes the source of truth),
 *                                 then DELETE the local rows so there's no
 *                                 shadow. The project becomes cloud-canonical.
 *   transferProjectToSelfHosted — copy an undeployed project's configuration
 *                                 home, then remove the remote configuration.
 *
 * SCOPE OF THIS FILE: the data-layer transfer, plus source-side teardown on the
 * PROMOTE path — which calls `teardownProject(… force, preserveWebhook)` once the
 * rows have landed, so that half is no longer deferred.
 *
 * A configuration transfer does not move application data. Deployed Cloud
 * projects use the project migration/backup workflow; no transfer owns or
 * deletes their subscription's managed server.
 */

import { reportCaughtError as observeCaughtError, diagnostics as errorDiagnostics } from "@repo/core/diagnostics";
import {
  dumpSubgraph,
  restoreSubgraph,
  deleteProjectSubgraph,
  stripInstanceRefsInPlace,
  PkCollisionError,
  repos,
  db,
  schema,
  eq,
  and,
  sql,
  type DatabaseDump,
  type SubgraphScope,
} from "@repo/db";
import { cloudClient } from "@repo/platform/engine/lib/cloud/client";
import { AppError } from "@repo/core";
import { randomUUID } from "node:crypto";
import { teardownProject, getActiveProjectState } from "@repo/platform/engine/modules/projects/project-teardown";
import type { ExecutionContext as RequestContext } from "@repo/platform";
import { withProjectRuntimeLock } from "../../lib/project-runtime-lock";
import { linkedCloudIdentity } from "../../lib/cloud/server-link";
import { sameCloudIdentity } from "../../lib/cloud/transport";
import { isProjectPromotion, projectPromotionDigest, type ProjectPromotion } from "../../lib/cloud/project-promotion";
import { assertProjectMutable } from "../../lib/resource-access";

// ─── Typed errors ────────────────────────────────────────────────────────────

export class TransferAlreadyOnTargetError extends Error {
  readonly code = "TRANSFER_ALREADY_ON_TARGET" as const;
  constructor(public readonly side: "cloud" | "self_hosted") {
    super(`Project is already hosted on ${side}.`);
    this.name = "TransferAlreadyOnTargetError";
  }
}

export class TransferConflictError extends Error {
  readonly code = "TRANSFER_CONFLICT" as const;
  constructor(
    public readonly conflictKind: "id" | "slug",
    public readonly conflictValue: string,
  ) {
    super(`Target organization already has a project with this ${conflictKind}: ${conflictValue}.${conflictKind === "id" ? " Review both copies before removing either one." : ""}`);
    this.name = "TransferConflictError";
  }
}

export class TransferNotConnectedError extends Error {
  readonly code = "TRANSFER_NOT_CONNECTED" as const;
  constructor() {
    super("This organization is not connected to Openship Cloud.");
    this.name = "TransferNotConnectedError";
  }
}

export class TransferCloudCallFailedError extends Error {
  readonly code = "TRANSFER_CLOUD_FAILED" as const;
  constructor(reason: string) {
    super(`Cloud transfer call failed: ${reason}`);
    this.name = "TransferCloudCallFailedError";
  }
}

export class TransferProjectNotFoundError extends Error {
  readonly code = "TRANSFER_PROJECT_NOT_FOUND" as const;
  constructor(projectId: string) {
    super(`Project ${projectId} not found.`);
    this.name = "TransferProjectNotFoundError";
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface ProjectRow {
  id: string;
  slug: string;
  organizationId: string;
  workspaceId: string | null;
  clusterId: string | null;
  cloudPromotion: ProjectPromotion | null;
  appTemplateId: string | null;
  gitProvider: string | null;
}

async function loadProject(projectId: string, organizationId: string): Promise<ProjectRow | null> {
  const rows = await db
    .select({
      id: schema.project.id,
      slug: schema.project.slug,
      organizationId: schema.project.organizationId,
      workspaceId: schema.project.workspaceId,
      clusterId: schema.project.clusterId,
      cloudPromotion: schema.project.cloudPromotion,
      appTemplateId: schema.project.appTemplateId,
      gitProvider: schema.project.gitProvider,
    })
    .from(schema.project)
    .where(eq(schema.project.id, projectId));
  const row = rows[0];
  if (!row) return null;
  if (row.organizationId !== organizationId) return null;
  return row;
}

// ─── Forward: local → cloud ──────────────────────────────────────────────────

export interface TransferToCloudInput {
  projectId: string;
  /** Caller's local org (becomes the SaaS org via cloud session). */
  organizationId: string;
}

export interface TransferToCloudResult {
  projectId: string;
  imported: Record<string, number>;
}

export async function transferProjectToCloud(
  input: TransferToCloudInput,
): Promise<TransferToCloudResult> {
  return withProjectRuntimeLock(input.projectId, () => transferProjectToCloudLocked(input));
}

async function sourceDigest(projectId: string): Promise<string> {
  return projectPromotionDigest(await dumpSubgraph({ kind: "project", projectId }));
}

async function assertUnchangedSource(projectId: string, state: ProjectPromotion): Promise<void> {
  if (await sourceDigest(projectId) !== state.sourceDigest)
    throw new AppError("The local project changed after this transfer started. Review both copies before continuing; further local cleanup was stopped.", 409, "TRANSFER_SOURCE_CHANGED");
}

async function transferProjectToCloudLocked(input: TransferToCloudInput): Promise<TransferToCloudResult> {
  // 1) Pre-flight: project exists in this org and isn't already on cloud.
  const project = await loadProject(input.projectId, input.organizationId);
  if (!project) throw new TransferProjectNotFoundError(input.projectId);
  assertProjectMutable(project);
  if (project.workspaceId) {
    throw new TransferAlreadyOnTargetError("cloud");
  }
  const [clusterRelease] = await db
    .select({ id: schema.deployment.id })
    .from(schema.deployment)
    .where(
      and(
        eq(schema.deployment.projectId, project.id),
        sql`${schema.deployment.meta}->>'clusterId' is not null`,
      ),
    )
    .limit(1);
  if (project.clusterId || clusterRelease)
    throw new AppError(
      "Projects with Kubernetes releases cannot be transferred to Cloud yet. Keep cluster workloads on this self-hosted installation.",
      409,
      "CLUSTER_TRANSFER_UNSUPPORTED",
    );

  // A transfer must not snapshot an in-flight deployment and then cancel work
  // that was never part of the imported configuration.
  if ((await getActiveProjectState(project.id)).blocking)
    throw new AppError("Finish or cancel this project's active work before transferring it.", 409, "TRANSFER_ACTIVE_WORK");

  const target = await linkedCloudIdentity(input.organizationId);
  let state = project.cloudPromotion;
  if (state) {
    if (!isProjectPromotion(state) || !sameCloudIdentity(state.target, target))
      throw new AppError("Reconnect the Cloud account and workspace used by the original transfer before retrying.", 409, "TRANSFER_CONNECTION_CHANGED");
    await assertUnchangedSource(project.id, state);
  } else {
    state = { id: randomUUID(), target, sourceDigest: await sourceDigest(project.id), imported: null };
    // Persist BEFORE the network call. A lost response or process restart reuses
    // this receipt instead of treating an unrelated matching ID as our import.
    await db.update(schema.project).set({ cloudPromotion: state }).where(
      and(eq(schema.project.id, project.id), eq(schema.project.organizationId, input.organizationId)),
    );
  }

  // 2) Dump the project subgraph from local. stripEncrypted: true — the
  //    SaaS can't decrypt local-host blobs; re-link is the operator's
  //    job on the cloud side.
  //    stripInstanceRefs: true — project.serverId points at a `servers` row that
  //    does not travel (instance-scope); the destination has its own servers.
  const dump = await dumpSubgraph(
    { kind: "project", projectId: input.projectId },
    { stripEncrypted: true, stripInstanceRefs: true },
  );

  // 3) Push to cloud. The SaaS derives merge mode from dump.scope and
  //    rewrites every organizationId onto the caller's SaaS org.
  const result = await cloudClient({
    organizationId: input.organizationId,
  }, target).ingestSubgraph({ dump, promotionId: state.id });

  if (!result.ok) {
    // These responses guarantee no import committed. Permit a corrected name
    // or updated Cloud API on the next attempt; never clear an acknowledged or
    // uncertain transfer merely because the connection failed.
    if (!state.imported && ["SLUG_TAKEN", "PK_COLLISION", "INGEST_VALIDATION_FAILED", "INGEST_FORMAT_MISMATCH"].includes(result.code ?? ""))
      await db.update(schema.project).set({ cloudPromotion: null }).where(
        and(eq(schema.project.id, project.id), eq(schema.project.organizationId, input.organizationId)),
      );
    // No cloud session linked for this org.
    if (/not connected/i.test(result.error)) {
      throw new TransferNotConnectedError();
    }
    if (result.code === "INGEST_VALIDATION_FAILED") {
      throw new TransferCloudCallFailedError(result.error);
    }
    // A DIFFERENT project on the SaaS already owns this project's name/slug —
    // a naming conflict, not a leftover copy. Surface it as a slug conflict so
    // callers show "rename and retry", never the leftover-copy cleanup message.
    if (result.code === "SLUG_TAKEN") {
      throw new TransferConflictError("slug", project.slug);
    }
    // A leftover SaaS copy of THIS project (its id already exists). Surfaces as
    // code "PK_COLLISION" (typed) or a "duplicate key value" message (legacy
    // SaaS). Reported as a conflict; cleanup is an explicit, runtime-aware
    // operation (not a deploy-triggered auto-delete).
    if (result.code === "PK_COLLISION" || result.code === "TRANSFER_CONFLICT" || /duplicate key value/i.test(result.error)) {
      throw new TransferConflictError("id", project.id);
    }
    throw new TransferCloudCallFailedError(result.error);
  }

  if (result.organizationId !== target.organizationId || result.promotionId !== state.id ||
    !isProjectPromotion({ ...state, imported: result.imported }))
    throw new AppError("Cloud did not confirm this transfer's receipt. The local project was preserved.", 502, "TRANSFER_RECEIPT_INVALID");
  if (!sameCloudIdentity(target, await linkedCloudIdentity(input.organizationId)))
    throw new AppError("The Cloud connection changed during transfer. Reconnect the original account before retrying.", 409, "TRANSFER_CONNECTION_CHANGED");
  // An edit during the Cloud call must never be silently erased by cleanup.
  await assertUnchangedSource(project.id, state);
  await db.update(schema.project).set({ cloudPromotion: { ...state, imported: result.imported } }).where(
    and(eq(schema.project.id, project.id), eq(schema.project.organizationId, input.organizationId)),
  );

  // 4) Ingest succeeded — the SaaS now owns this project (cloud-as-source).
  //    The CALLER (transfer.controller) tears down the local runtime AND drops
  //    the local rows via teardownProject({ preserveWebhook: true }) — that
  //    reuses the tested teardown path so a promoted project leaves no orphaned
  //    local container, while keeping the GitHub webhook for the cloud copy.
  //    Only the receipt is changed here. Runtime teardown remains retryable.
  //
  // Remaining follow-up (operational, not data): hand custom-domain DNS over to
  // the cloud workspace; the local routes are removed by the teardown but DNS
  // re-pointing for user-managed domains is the operator's step.

  return {
    projectId: project.id,
    imported: result.imported,
  };
}

export interface PromoteToCloudResult {
  projectId: string;
  imported: Record<string, number>;
  /** False when ingest succeeded but local teardown couldn't drop the row (drift). */
  localRemoved: boolean;
  /** >0 means the row dropped but some local resource needs manual cleanup. */
  unrecoverableSteps: number;
}

/**
 * PROMOTE a local project to Openship Cloud: ingest its subgraph to the SaaS
 * (which becomes the source of truth), then tear down the local runtime + rows
 * via the tested teardown path (keeping the GitHub webhook, since the cloud
 * copy still auto-deploys). Used only by the explicit transfer operation;
 * deploying to a managed server does not transfer control-plane records.
 *
 * Throws (from transferProjectToCloud) if the project is already on cloud or
 * the org isn't connected — callers surface those.
 */
export async function promoteProjectToCloud(
  ctx: RequestContext,
  projectId: string,
): Promise<PromoteToCloudResult> {
  return withProjectRuntimeLock(projectId, () => promoteProjectToCloudLocked(ctx, projectId));
}

async function promoteProjectToCloudLocked(ctx: RequestContext, projectId: string): Promise<PromoteToCloudResult> {
  const { imported } = await transferProjectToCloud({
    projectId,
    organizationId: ctx.organizationId,
  });

  // The teardown below keeps the GitHub webhook but drops the local row (and its
  // secret). Persist a binding first so a push forwarded from this box can find
  // the cloud project and hard-validate the signature. cloudProjectId == the
  // local id (dump/ingest preserves it); the secret ciphertext is copied verbatim.
  const local = await repos.project.findById(projectId);
  const receipt = local?.cloudPromotion;
  if (!isProjectPromotion(receipt) || !receipt.imported)
    throw new AppError("The confirmed transfer receipt is unavailable. The local project was preserved.", 409, "TRANSFER_RECEIPT_INVALID");
  const teardown = await teardownProject(ctx, projectId, {
    // Work admitted after the import must be kept, never cancelled as cleanup
    // of a snapshot that did not contain it.
    force: false,
    preserveWebhook: true,
    validateConfiguration: async () => {
      await assertUnchangedSource(projectId, receipt);
      if (local?.gitOwner && local?.gitRepo && local?.webhookId) {
        await repos.cloudWebhookBinding.upsert({
          organizationId: ctx.organizationId,
          cloudProjectId: projectId,
          gitOwner: local.gitOwner,
          gitRepo: local.gitRepo,
          gitBranch: local.gitBranch ?? "",
          webhookId: local.webhookId,
          webhookSecret: local.webhookSecret ?? null,
        });
      }
    },
  });
  return {
    projectId,
    imported,
    localRemoved: teardown.rowDeleted,
    unrecoverableSteps: teardown.unrecoverable.length,
  };
}

// ─── Reverse: cloud → local ──────────────────────────────────────────────────

export interface TransferToSelfHostedInput {
  projectId: string;
  organizationId: string;
}

export interface TransferToSelfHostedResult {
  projectId: string;
  imported: Record<string, number>;
}

export async function transferProjectToSelfHosted(
  input: TransferToSelfHostedInput,
): Promise<TransferToSelfHostedResult> {
  // 1) Pre-flight: project exists in this org and IS currently on cloud.
  const project = await loadProject(input.projectId, input.organizationId);
  if (!project) throw new TransferProjectNotFoundError(input.projectId);
  if (!project.workspaceId) {
    throw new TransferAlreadyOnTargetError("self_hosted");
  }

  // 2) Pull the project subgraph from the SaaS.
  const scope: SubgraphScope = { kind: "project", projectId: input.projectId };
  const result = await cloudClient({
    organizationId: input.organizationId,
  }).exportSubgraph({ scope });
  if (!result.ok) {
    if (/not connected/i.test(result.error)) {
      throw new TransferNotConnectedError();
    }
    throw new TransferCloudCallFailedError(result.error);
  }
  const dump: DatabaseDump = result.dump;
  if ((dump.tables.deployment?.length ?? 0) > 0) {
    throw new AppError(
      "This project has deployment history on its managed server. Move its runtime and persistent data with the project migration or backup workflow before transferring configuration.",
      409,
      "PROJECT_DATA_TRANSFER_REQUIRED",
    );
  }
  stripInstanceRefsInPlace(dump.tables);

  // 3) Wipe the local rows for this project, then merge-insert the dump.
  //    Uses the shared subgraph-delete primitive (child→parent FK order,
  //    leaves the shared project_app parent) — the same one the SaaS teardown
  //    uses, so both sides stay in lockstep.
  await deleteProjectSubgraph(project.id);

  try {
    await restoreSubgraph(dump, {
      mode: "merge",
      remapOrgId: input.organizationId,
    });
  } catch (err) {
    // PkCollisionError = caller already pulled this project back at some
    // point and didn't clean up local shadow rows fully. We map it to
    // TransferConflictError so the dashboard surfaces a recoverable
    // "already exists locally" rather than an opaque 500.
    if (err instanceof PkCollisionError) {
      throw new TransferConflictError("id", project.id);
    }
    throw err;
  }

  // 4) Clear workspaceId; project is now canonical-local again.
  await db
    .update(schema.project)
    .set({ workspaceId: null, updatedAt: new Date() })
    .where(eq(schema.project.id, project.id));

  // The project is local again — drop any cloud webhook binding so pushes are
  // handled locally, not forwarded to the (now torn-down) SaaS copy.
  await repos.cloudWebhookBinding.deleteByCloudProject(project.id).catch((diagnosticFailure) => {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/projects/transfer.service");
  });

  // 5) Tear down the SaaS copy's ROWS so it doesn't linger as a leftover that
  //    would collide on a future re-promote. Best-effort: the local copy is
  //    already authoritative, so a teardown failure is drift to reconcile later
  //    (via the teardown endpoint), not a reason to fail the bring-home.
  //    The remote endpoint rechecks that this is still an undeployed project
  //    under its runtime lock. It never removes a shared server or its neighbors.
  const teardown = await cloudClient({
    organizationId: input.organizationId,
  }).teardownProject({ projectId: project.id });
  if (!teardown.ok) {
    errorDiagnostics.warn("platform/engine/modules/projects/transfer.service",
      `[transfer] bring-home: cloud teardown failed for project ${project.id}: ${teardown.error}`,
    );
  }

  const imported = Object.fromEntries(
    Object.entries(dump.tables)
      .filter(([, rows]) => rows.length > 0)
      .map(([k, v]) => [k, v.length]),
  );

  return { projectId: project.id, imported };
}
