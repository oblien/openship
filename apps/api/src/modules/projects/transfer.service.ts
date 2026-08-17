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
  //    stripInstanceRefs: true — project.serverId points at a `servers` row that
  //    does not travel (instance-scope) and cannot exist on the SaaS, and the FK is
  //    not DEFERRABLE, so shipping it takes a raw FK violation at insert.
  const dump = await dumpSubgraph(
    { kind: "project", projectId: input.projectId },
    { stripEncrypted: true, stripInstanceRefs: true },
  );

  // 3) Push to cloud. The SaaS derives merge mode from dump.scope and
  //    rewrites every organizationId onto the caller's SaaS org.
  throw new TransferCloudCallFailedError("Project transfer to Cloud is not available on Operator.");
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
  throw new TransferCloudCallFailedError("Cloud transfer is not available on Operator.");
}
