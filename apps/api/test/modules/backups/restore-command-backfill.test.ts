/**
 * D5, second half: the runs already captured.
 *
 * Forwarding `payloadConfig` fixes new backups. It does nothing for the archives
 * already sitting in a destination, because `metadata.restoreCommand` was frozen
 * into `backup_run.artifacts` at capture time and that record is the ONLY thing
 * `CustomCommandProducer.restore` consults. On any instance with a mail server,
 * every run in that history currently reads `restoreCommand: null`.
 *
 * These run against the real PGlite database (separate file from
 * custom-command-config.test.ts, which mocks `@repo/db` file-scoped) because the
 * behavior under test IS the SQL predicate that decides which rows are broken.
 */

import { db, repos, schema } from "@repo/db";
import { beforeEach, describe, expect, it } from "vitest";

import { backfillCustomCommandRestoreCommands } from "../../../src/modules/backups/restore-command-backfill";
import { seedBackupDestination, seedBackupPolicy, seedBackupRun, seedOrg } from "../../helpers/seed";

/** What mail/admin/backup-plan.ts writes onto the policy. */
const MAIL_PAYLOAD = {
  produceCommand: "tar -C /var/vmail -cf - .",
  restoreCommand: "tar -C /var/vmail -xf -",
  artifactName: "mail.tar.zst",
};

/** An artifact as the broken orchestrator recorded it. */
const brokenArtifact = (over: Record<string, unknown> = {}) => ({
  name: "custom-backup.bin",
  key: "org/run/custom-backup.bin",
  sizeBytes: 4096,
  sha256: "a".repeat(64),
  payloadKind: "custom_command",
  metadata: { produceCommand: null, restoreCommand: null },
  ...over,
});

interface Entry {
  payloadKind?: string;
  metadata?: Record<string, unknown> | null;
}

describe("custom_command restoreCommand backfill", () => {
  let organizationId: string;
  let destinationId: string;

  beforeEach(async () => {
    // The backfill is instance-wide (it's a boot hook, not an org operation) and
    // the PGlite instance is per FILE, so a previous case's deliberately
    // unrecoverable run would show up in every later result.
    await db.delete(schema.backupRun);
    await db.delete(schema.backupPolicy);
    ({ organizationId } = await seedOrg());
    destinationId = (await seedBackupDestination(organizationId)).id;
  });

  const artifactsOf = async (runId: string) =>
    ((await repos.backupRun.findById(runId))!.artifacts ?? []) as Entry[];

  it("recovers the command from the owning policy and stamps its provenance", async () => {
    const policy = await seedBackupPolicy(destinationId, {
      sourceKind: "mail_server",
      payloadKind: "custom_command",
      payloadConfig: MAIL_PAYLOAD,
    });
    const run = await seedBackupRun(organizationId, {
      policyId: policy.id,
      sourceKind: "mail_server",
      artifacts: [brokenArtifact()],
    });

    const result = await backfillCustomCommandRestoreCommands();
    expect(result).toEqual({ repaired: 1, unrecoverable: [] });

    const [entry] = await artifactsOf(run.id);
    expect(entry!.metadata!.restoreCommand).toBe(MAIL_PAYLOAD.restoreCommand);
    // Provenance: a repaired command was derived, not captured. An operator
    // debugging a restore needs to know which of the two it's looking at.
    expect(entry!.metadata!.restoreCommandBackfilledFrom).toBe(policy.id);
    // produceCommand is filled in alongside, since the capture dropped it too.
    expect(entry!.metadata!.produceCommand).toBe(MAIL_PAYLOAD.produceCommand);
  });

  it("leaves everything else on the artifact alone", async () => {
    const policy = await seedBackupPolicy(destinationId, { payloadConfig: MAIL_PAYLOAD });
    const run = await seedBackupRun(organizationId, {
      policyId: policy.id,
      artifacts: [brokenArtifact()],
    });

    await backfillCustomCommandRestoreCommands();

    const [entry] = (await artifactsOf(run.id)) as Array<Record<string, unknown>>;
    // The archive itself did not change — only our record of how to unpack it.
    // A rewritten key or digest would make the repaired row unverifiable.
    expect(entry).toMatchObject({
      name: "custom-backup.bin",
      key: "org/run/custom-backup.bin",
      sizeBytes: 4096,
      sha256: "a".repeat(64),
    });
    const after = (await repos.backupRun.findById(run.id))!;
    expect(after.status).toBe("succeeded");
  });

  it("reports a run whose policy is gone instead of guessing", async () => {
    // policyId is SET NULL on policy delete, so history outlives the schedule —
    // and takes the only copy of the command with it.
    const run = await seedBackupRun(organizationId, {
      policyId: null,
      artifacts: [brokenArtifact()],
    });

    const result = await backfillCustomCommandRestoreCommands();
    expect(result.repaired).toBe(0);
    expect(result.unrecoverable).toEqual([run.id]);

    // Untouched: a fabricated command would fail at the worst possible moment,
    // and the operator would have no signal it was invented.
    const [entry] = await artifactsOf(run.id);
    expect(entry!.metadata!.restoreCommand).toBeNull();
  });

  it("reports a policy that has no restoreCommand of its own", async () => {
    const policy = await seedBackupPolicy(destinationId, {
      payloadConfig: { produceCommand: "pg_dump …" },
    });
    const run = await seedBackupRun(organizationId, {
      policyId: policy.id,
      artifacts: [brokenArtifact()],
    });

    const result = await backfillCustomCommandRestoreCommands();
    expect(result.repaired).toBe(0);
    expect(result.unrecoverable).toEqual([run.id]);
  });

  it("is idempotent — a second pass finds nothing to do", async () => {
    const policy = await seedBackupPolicy(destinationId, { payloadConfig: MAIL_PAYLOAD });
    await seedBackupRun(organizationId, {
      policyId: policy.id,
      artifacts: [brokenArtifact()],
    });

    expect((await backfillCustomCommandRestoreCommands()).repaired).toBe(1);
    // The work list is "artifacts still broken", so a repaired run stops
    // matching — this hook runs on every boot.
    expect(await backfillCustomCommandRestoreCommands()).toEqual({
      repaired: 0,
      unrecoverable: [],
    });
  });

  it("ignores artifacts that were never broken", async () => {
    const policy = await seedBackupPolicy(destinationId, { payloadConfig: MAIL_PAYLOAD });
    const healthy = await seedBackupRun(organizationId, {
      policyId: policy.id,
      artifacts: [
        brokenArtifact({
          name: "mail.tar.zst",
          metadata: { restoreCommand: "already-here -xf -" },
        }),
      ],
    });
    const volume = await seedBackupRun(organizationId, {
      policyId: policy.id,
      artifacts: [brokenArtifact({ payloadKind: "volume", metadata: {} })],
    });

    expect(await backfillCustomCommandRestoreCommands()).toEqual({
      repaired: 0,
      unrecoverable: [],
    });

    const [kept] = await artifactsOf(healthy.id);
    expect(kept!.metadata!.restoreCommand).toBe("already-here -xf -");
    expect(kept!.metadata!.restoreCommandBackfilledFrom).toBeUndefined();
    // A volume artifact has no restoreCommand by design; matching it would
    // stamp a mail shell onto a tar-into-volume restore.
    const [untouched] = await artifactsOf(volume.id);
    expect(untouched!.metadata).toEqual({});
  });

  it("repairs many runs of one policy and tolerates an empty artifact list", async () => {
    const policy = await seedBackupPolicy(destinationId, { payloadConfig: MAIL_PAYLOAD });
    for (let i = 0; i < 3; i++) {
      await seedBackupRun(organizationId, {
        policyId: policy.id,
        artifacts: [brokenArtifact()],
      });
    }
    // A run that failed before it captured anything.
    await seedBackupRun(organizationId, {
      policyId: policy.id,
      status: "failed",
      artifacts: [],
    });

    expect(await backfillCustomCommandRestoreCommands()).toEqual({
      repaired: 3,
      unrecoverable: [],
    });
  });

  it("skips soft-deleted runs", async () => {
    const policy = await seedBackupPolicy(destinationId, { payloadConfig: MAIL_PAYLOAD });
    const run = await seedBackupRun(organizationId, {
      policyId: policy.id,
      artifacts: [brokenArtifact()],
      deletedAt: new Date(),
    });

    expect(await backfillCustomCommandRestoreCommands()).toEqual({
      repaired: 0,
      unrecoverable: [],
    });
    const [entry] = await artifactsOf(run.id);
    expect(entry!.metadata!.restoreCommand).toBeNull();
  });
});
