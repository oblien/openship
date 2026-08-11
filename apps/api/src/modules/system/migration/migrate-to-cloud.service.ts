/**
 * Path B: migrate this self-hosted instance to Openship Cloud.
 *
 * Orchestration:
 *   1. Verify the operator is cloud-connected (must have linked their
 *      cloud account first — wizard guides through that if not).
 *   2. Dump the local DB.
 *   3. POST the dump to /api/cloud/ingest-subgraph via cloudClient —
 *      authenticated as the org owner. SaaS imports into the caller's
 *      active SaaS organization.
 *   4. Flip local instance_settings.teamMode → "cloud_hosted" and
 *      stamp migrationTargetUrl with the public URL the SaaS returned.
 *      Dashboard renders the MigratedLauncher from PR 1.
 *   5. Audit log.
 *
 * No release dist needed, no SSH, no domain config — the SaaS IS the
 * target, and it's already running. This is the simpler of the two
 * migration paths.
 *
 * SAFETY: refuses to run when the operator isn't cloud-connected
 * (no session token → cloudClient can't authenticate). Bubbles up
 * the "target org has existing projects" error so the wizard can
 * prompt the operator to acknowledge a non-empty target and proceed
 * (they handle any PK collisions themselves — nothing is wiped).
 *
 * Lock + audit + settings-upsert ceremony lives in `withMigration` —
 * this file owns only the dump → ingest → finale shape.
 */

import type { Context } from "hono";
import { cloudRequiredCode } from "@repo/core";
import { dumpSubgraph } from "@repo/db";
import { cloudClient } from "../../../lib/cloud/client";
import { withMigration } from "./with-migration";

export interface MigrateToCloudInput {
  organizationId: string;
  userId: string;
  c: Context;
  /**
   * Acknowledge that the target cloud org may already have rows and
   * proceed anyway — caller handles any PK collisions. Does NOT wipe
   * the existing cloud org.
   */
  allowNonEmptyTarget?: boolean;
}

export interface MigrateToCloudResult {
  organizationId: string;
  publicUrl: string;
  imported: Record<string, number>;
}

export class MigrateToCloudNotConnectedError extends Error {
  // Sourced from the shared cloud-capability registry (single source of truth);
  // identical string, no wire-format change.
  readonly code = cloudRequiredCode("migrate-to-cloud");
  constructor() {
    super(
      "This instance is not connected to Openship Cloud. Connect your cloud account in Settings first.",
    );
    this.name = "MigrateToCloudNotConnectedError";
  }
}

export class MigrateToCloudTargetNotEmptyError extends Error {
  readonly code = "MIGRATE_TO_CLOUD_TARGET_NOT_EMPTY" as const;
  constructor(public readonly projectCount: number) {
    super(
      `Your Openship Cloud organization already has ${projectCount} project(s). Set allowNonEmptyTarget=true to proceed.`,
    );
    this.name = "MigrateToCloudTargetNotEmptyError";
  }
}

export class MigrateToCloudFailedError extends Error {
  readonly code = "MIGRATE_TO_CLOUD_FAILED" as const;
  constructor(reason: string) {
    super(`Cloud ingest failed: ${reason}`);
    this.name = "MigrateToCloudFailedError";
  }
}

export async function migrateInstanceToCloud(
  input: MigrateToCloudInput,
): Promise<MigrateToCloudResult> {
  return withMigration<MigrateToCloudInput, MigrateToCloudResult>(
    {
      direction: "forward",
      variant: "cloud-hosted",
      c: input.c,
      organizationId: input.organizationId,
      userId: input.userId,
      input,
    },
    async (ctx) => {
      // ── 1. Dump local DB. Done up front so the actual cloud call has a
      //       payload ready and we fail fast on dump errors before any
      //       network work.
      //
      //       stripEncrypted: encrypted columns (cloud_session_token,
      //       clone_token_encrypted, env_var.value, backup_destination.*Enc,
      //       deployment.env_vars, notification_channel.config) won't
      //       decrypt with the SaaS's BETTER_AUTH_SECRET. We null them and
      //       surface `strippedEncryptedFields` to the wizard so the
      //       operator knows what to re-link on the cloud side.
      //
      //       Why organization-scope: forward-migration to the SaaS is
      //       multi-tenant on the SaaS side. Instance-scope (which carries
      //       user/auth/instance_settings rows) would conflict with the
      //       SaaS's own auth tables; ingestSubgraph rejects it. An
      //       organization-scope dump carries exactly the rows the SaaS
      //       wants to import.
      const dump = await dumpSubgraph(
        { kind: "organization", organizationId: ctx.input.organizationId },
        { stripEncrypted: true },
      );

      // ── 2. POST to SaaS — cloudClient handles auth (org owner's cloud
      //       session token) and the JSON envelope. ────────────────────────
      const result = await cloudClient({
        organizationId: ctx.input.organizationId,
      }).ingestSubgraph({
        dump,
        allowNonEmptyTarget: ctx.input.allowNonEmptyTarget,
      });

      if (!result.ok) {
        if (result.code === cloudRequiredCode("migrate-to-cloud")) {
          throw new MigrateToCloudNotConnectedError();
        }
        if (result.code === "INGEST_TARGET_NOT_EMPTY") {
          throw new MigrateToCloudTargetNotEmptyError(result.projectCount ?? 0);
        }
        // cloudClient maps a missing session to this exact string — translate
        // to a typed error so the controller can return a clean 412.
        if (result.error === "Not connected to Openship Cloud") {
          throw new MigrateToCloudNotConnectedError();
        }
        throw new MigrateToCloudFailedError(result.error);
      }

      // ── 3. Finale. `withMigration` performs the instance_settings
      //       upsert + success audit; we hand it the patch + the typed
      //       result + any cloud-specific extras for the audit `after`. ────
      const migratedAt = new Date();
      return {
        settings: {
          teamMode: "cloud_hosted",
          migrationTargetUrl: result.publicUrl,
          migratedAt,
        },
        result: {
          organizationId: result.organizationId,
          publicUrl: result.publicUrl,
          imported: result.imported,
        },
        auditAfter: {
          importedTables: Object.keys(result.imported),
        },
      };
    },
  );
}
