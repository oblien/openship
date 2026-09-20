/**
 * SaaS-side subgraph ingest/export — receive or emit a DB subgraph dump.
 *
 * Both export and ingest are thin wrappers around dumpSubgraph /
 * restoreSubgraph; the dump's `scope` field is the discriminator.
 *
 * - Forward (local → SaaS): `ingestSubgraph` accepts an organization-
 *   scope or project-scope dump, remaps every organizationId onto the
 *   caller's SaaS org, and inserts.
 * - Reverse (SaaS → local): `exportSubgraph` emits an organization- or
 *   project-scope dump for the caller's org. Instance-scope export is
 *   refused server-side (the SaaS never wants to leak its own auth /
 *   instance state to a self-hosted instance).
 */

import {
  db,
  schema,
  and,
  eq,
  sql,
  dumpSubgraph,
  restoreSubgraph,
  deleteProjectSubgraph,
  DUMP_FORMAT_VERSION,
  type DatabaseDump,
  type SubgraphScope,
} from "@repo/db";
import { cloudRuntimeTarget } from "@repo/platform/engine/config/env";

export class IngestValidationError extends Error {
  readonly code = "INGEST_VALIDATION_FAILED" as const;
  constructor(message: string) {
    super(message);
    this.name = "IngestValidationError";
  }
}

export class IngestTargetNotEmptyError extends Error {
  readonly code = "INGEST_TARGET_NOT_EMPTY" as const;
  constructor(public readonly projectCount: number) {
    super(
      `Target organization already has ${projectCount} project(s). Pass allowNonEmptyTarget=true to proceed.`,
    );
    this.name = "IngestTargetNotEmptyError";
  }
}

// ─── New generalized primitives ──────────────────────────────────────────────

/**
 * Export the subgraph for `scope` from the SaaS DB. The scope is whatever
 * the caller has permission to read — the route layer is responsible for
 * authorising it (e.g. /export-subgraph rejects an instance scope; only
 * org-owners can request their own org; project scope requires that the
 * project belongs to the caller's org).
 */
export async function exportSubgraph(scope: SubgraphScope): Promise<DatabaseDump> {
  return dumpSubgraph(scope, { stripEncrypted: true });
}

export interface IngestSubgraphInput {
  /** SaaS org the data lands in. */
  organizationId: string;
  /** Decoded dump. */
  dump: DatabaseDump;
  /**
   * Acknowledge that the target org may already have rows and proceed
   * anyway — caller handles any PK collisions. Does NOT wipe existing
   * rows. Org-scope only; project-scope is handled by the caller.
   */
  allowNonEmptyTarget?: boolean;
}

export interface IngestSubgraphResult {
  organizationId: string;
  publicUrl: string;
  imported: Record<string, number>;
}

/**
 * Ingest a subgraph into the SaaS, remapping organizationId on every row
 * with one. Mode is `merge` for both organization and project scope:
 *   - organization → target is the operator's org; teammates' user/auth
 *                    rows already exist independently.
 *   - project      → single project addition; PK collision = duplicate.
 *
 * Instance-scope ingest is rejected — the SaaS never wants to replace
 * its own auth/instance state from a self-hosted dump.
 */
export async function ingestSubgraph(
  input: IngestSubgraphInput,
): Promise<IngestSubgraphResult> {
  // ── 1. Validate ───────────────────────────────────────────────────────────
  if (input.dump.formatVersion !== DUMP_FORMAT_VERSION) {
    throw new IngestValidationError(
      `Dump format version ${input.dump.formatVersion} is incompatible with this SaaS (expected ${DUMP_FORMAT_VERSION}).`,
    );
  }
  if (!input.dump.scope || input.dump.scope.kind === "instance") {
    throw new IngestValidationError(
      "Instance-scope dumps cannot be ingested on the SaaS.",
    );
  }

  // ── 2. Safety check (org-scope only; project-scope handled by caller) ────
  if (input.dump.scope.kind === "organization" && !input.allowNonEmptyTarget) {
    const existing = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.project)
      .where(eq(schema.project.organizationId, input.organizationId));
    const count = existing[0]?.count ?? 0;
    if (count > 0) throw new IngestTargetNotEmptyError(count);
  }

  // ── 3. Count imported rows (returned for the UX toast) ───────────────────
  const imported: Record<string, number> = {};
  for (const [name, rows] of Object.entries(input.dump.tables)) {
    if (rows.length > 0) imported[name] = rows.length;
  }

  // ── 4. Restore (merge + remap to target org) ─────────────────────────────
  await restoreSubgraph(input.dump, { mode: "merge", remapOrgId: input.organizationId });

  return {
    organizationId: input.organizationId,
    publicUrl: cloudRuntimeTarget.dashboard,
    imported,
  };
}

export class TeardownProjectNotFoundError extends Error {
  readonly code = "TEARDOWN_PROJECT_NOT_FOUND" as const;
  constructor(public readonly projectId: string) {
    super(`Project ${projectId} not found in this organization.`);
    this.name = "TeardownProjectNotFoundError";
  }
}

/**
 * The tenant boundary for project-scoped cloud ops (export, teardown): true
 * only when `projectId` exists AND belongs to `organizationId`. Shared so the
 * ownership gate is identical across every SaaS handler that names a project.
 */
export async function projectExistsInOrg(
  projectId: string,
  organizationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: schema.project.id })
    .from(schema.project)
    .where(
      and(
        eq(schema.project.id, projectId),
        eq(schema.project.organizationId, organizationId),
      ),
    );
  return rows.length > 0;
}

/**
 * Delete a project's rows from the SaaS DB for the caller's org. Powers:
 *   - bring-home cleanup (remove the SaaS copy once a project is demoted local),
 *   - force-reconcile (a local promote finds a leftover cloud copy from an
 *     earlier promote/bring-home and cleans it before re-ingesting).
 *
 * Ownership is enforced: the project MUST belong to `organizationId`, so a
 * cloud session can never delete another tenant's project. Leaves the shared
 * `project_app` parent intact (see deleteProjectSubgraph).
 */
export async function teardownProjectSubgraph(input: {
  organizationId: string;
  projectId: string;
}): Promise<void> {
  if (!(await projectExistsInOrg(input.projectId, input.organizationId))) {
    throw new TeardownProjectNotFoundError(input.projectId);
  }
  await deleteProjectSubgraph(input.projectId);
}

