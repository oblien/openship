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
 *   transferProjectToSelfHosted — bring-home: pull project subgraph from SaaS,
 *                                 wipe the local rows, restore, clear
 *                                 cloudWorkspaceId. (Demote — see plan.)
 *
 * SCOPE OF THIS FILE: data-layer transfer only. Container teardown on the
 * source side, mail-server reattachment, GitHub installation re-binding,
 * DNS / domain re-provisioning, and racing concurrent deploys are
 * INTENTIONALLY deferred for the business-logic discussion. The hooks for
 * those live as TODOs below.
 */

import {
  dumpSubgraph,
  restoreSubgraph,
  deleteProjectSubgraph,
  PkCollisionError,
  repos,
  db,
  schema,
  eq,
  type DatabaseDump,
  type SubgraphScope,
} from "@repo/db";
import { cloudClient } from "../../lib/cloud/client";
import { teardownProject } from "./project-teardown";
import type { RequestContext } from "../../lib/request-context";

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
    super(
      `Target organization already has a project with this ${conflictKind}: ${conflictValue}.`,
    );
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
  cloudWorkspaceId: string | null;
}

async function loadProject(
  projectId: string,
  organizationId: string,
): Promise<ProjectRow | null> {
  const rows = await db
    .select({
      id: schema.project.id,
      slug: schema.project.slug,
      organizationId: schema.project.organizationId,
      cloudWorkspaceId: schema.project.cloudWorkspaceId,
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
  // 1) Pre-flight: project exists in this org and isn't already on cloud.
  const project = await loadProject(input.projectId, input.organizationId);
  if (!project) throw new TransferProjectNotFoundError(input.projectId);
  if (project.cloudWorkspaceId) {
    throw new TransferAlreadyOnTargetError("cloud");
  }

  // 2) Dump the project subgraph from local. stripEncrypted: true — the
  //    SaaS can't decrypt local-host blobs; re-link is the operator's
  //    job on the cloud side.
  const dump = await dumpSubgraph(
    { kind: "project", projectId: input.projectId },
    { stripEncrypted: true },
  );

  // 3) Push to cloud. The SaaS derives merge mode from dump.scope and
  //    rewrites every organizationId onto the caller's SaaS org.
  const result = await cloudClient({
    organizationId: input.organizationId,
  }).ingestSubgraph({ dump });

  if (!result.ok) {
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
    if (result.code === "PK_COLLISION" || /duplicate key value/i.test(result.error)) {
      throw new TransferConflictError("id", project.id);
    }
    throw new TransferCloudCallFailedError(result.error);
  }

  // 4) Ingest succeeded — the SaaS now owns this project (cloud-as-source).
  //    The CALLER (transfer.controller) tears down the local runtime AND drops
  //    the local rows via teardownProject({ preserveWebhook: true }) — that
  //    reuses the tested teardown path so a promoted project leaves no orphaned
  //    local container, while keeping the GitHub webhook for the cloud copy.
  //    We deliberately do NOT touch local state here so a teardown failure is
  //    reported as recoverable drift rather than a half-deleted project.
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
 * copy still auto-deploys). Single orchestration reused by BOTH the explicit
 * `/transfer/to-cloud` route AND born-on-cloud (first cloud deploy).
 *
 * Throws (from transferProjectToCloud) if the project is already on cloud or
 * the org isn't connected — callers surface those.
 */
export async function promoteProjectToCloud(
  ctx: RequestContext,
  projectId: string,
): Promise<PromoteToCloudResult> {
  const { imported } = await transferProjectToCloud({
    projectId,
    organizationId: ctx.organizationId,
  });

  // The teardown below keeps the GitHub webhook but drops the local row (and its
  // secret). Persist a binding first so a push forwarded from this box can find
  // the cloud project and hard-validate the signature. cloudProjectId == the
  // local id (dump/ingest preserves it); the secret ciphertext is copied verbatim.
  const local = await repos.project.findById(projectId).catch(() => null);
  if (local?.gitOwner && local?.gitRepo && local?.webhookId) {
    await repos.cloudWebhookBinding
      .upsert({
        organizationId: ctx.organizationId,
        cloudProjectId: projectId,
        gitOwner: local.gitOwner,
        gitRepo: local.gitRepo,
        gitBranch: local.gitBranch ?? "",
        webhookId: local.webhookId,
        webhookSecret: local.webhookSecret ?? null,
      })
      .catch((err) =>
        console.warn(`[transfer] cloud webhook binding upsert failed for ${projectId}:`, err),
      );
  }

  const teardown = await teardownProject(ctx, projectId, {
    force: true,
    preserveWebhook: true,
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
  if (!project.cloudWorkspaceId) {
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

  // 4) Clear cloudWorkspaceId; project is now canonical-local again.
  await db
    .update(schema.project)
    .set({ cloudWorkspaceId: null, updatedAt: new Date() })
    .where(eq(schema.project.id, project.id));

  // The project is local again — drop any cloud webhook binding so pushes are
  // handled locally, not forwarded to the (now torn-down) SaaS copy.
  await repos.cloudWebhookBinding
    .deleteByCloudProject(project.id)
    .catch(() => {});

  // 5) Tear down the SaaS copy's ROWS so it doesn't linger as a leftover that
  //    would collide on a future re-promote. Best-effort: the local copy is
  //    already authoritative, so a teardown failure is drift to reconcile later
  //    (via the teardown endpoint), not a reason to fail the bring-home.
  //    SCOPE: data-only — this drops rows, it does NOT destroy the cloud
  //    workspace RUNTIME. Row-only leftovers (never-deployed promotes, dev) are
  //    fully cleaned; a project that was actually RUNNING on cloud leaves its
  //    workspace to be destroyed by the deferred cloud-workspace teardown below.
  const teardown = await cloudClient({
    organizationId: input.organizationId,
  }).teardownProject({ projectId: project.id });
  if (!teardown.ok) {
    console.warn(
      `[transfer] bring-home: cloud teardown failed for project ${project.id}: ${teardown.error}`,
    );
  }

  // TODO (business-logic phase, NOT in this change):
  //   - destroy the cloud workspace RUNTIME (containers/routes) for a project
  //     that was live on cloud — teardownProject above is data-only
  //   - kick the local deploy pipeline so containers come back up
  //   - re-bind GitHub installation to the local org
  //   - audit_event row

  const imported = Object.fromEntries(
    Object.entries(dump.tables)
      .filter(([, rows]) => rows.length > 0)
      .map(([k, v]) => [k, v.length]),
  );

  return { projectId: project.id, imported };
}
