/**
 * D5, second half: the runs already captured.
 *
 * Forwarding `payloadConfig` fixes new backups. It does nothing for the archives
 * already sitting in a destination, because `metadata.restoreCommand` was frozen
 * into `backup_run.artifacts` at capture time and that record is the ONLY thing
 * `CustomCommandProducer.restore` consults. On any instance with a mail server,
 * every run in that history currently reads `restoreCommand: null`.
 *
 * A SECOND shape lands in the same hook: runs whose recorded command was
 * credential-SCRUBBED on the way into jsonb (the metadata used to go through the
 * build-log redactor, which rewrites URL userinfo to `***@`). That one is worse than
 * the null case — the command is present, so nothing flagged it, and the restore dies
 * on authentication after the artifact has already streamed.
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

/**
 * A policy whose commands carry a DSN, and the same two AS THE SCRUBBER STORED THEM.
 * `://***@` is the redactor's own output — a real DSN has credentials in that position
 * and a credential-less one has no `@` at all — which is why it is safe to key on.
 */
const DSN_PAYLOAD = {
  produceCommand: 'mongodump --uri "mongodb://root:s3cr3t@db:27017/?authSource=admin" --archive',
  restoreCommand:
    'mongorestore --uri "mongodb://root:s3cr3t@db:27017/?authSource=admin" --archive',
};
const SCRUBBED_DUMP = 'mongodump --uri "mongodb://***@db:27017/?authSource=admin" --archive';
const SCRUBBED_RESTORE =
  'mongorestore --uri "mongodb://***@db:27017/?authSource=admin" --archive';

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

  it("repairs a command whose credentials were scrubbed at capture time", async () => {
    // The stored shape: present, plausible, and guaranteed to fail auth. The null
    // check that found the D5 rows cannot see this one.
    const policy = await seedBackupPolicy(destinationId, { payloadConfig: DSN_PAYLOAD });
    const run = await seedBackupRun(organizationId, {
      policyId: policy.id,
      artifacts: [
        brokenArtifact({
          metadata: {
            produceCommand: SCRUBBED_DUMP,
            restoreCommand: SCRUBBED_RESTORE,
          },
        }),
      ],
    });

    expect(await backfillCustomCommandRestoreCommands()).toEqual({
      repaired: 1,
      unrecoverable: [],
    });

    const [entry] = await artifactsOf(run.id);
    expect(entry!.metadata!.restoreCommand).toBe(DSN_PAYLOAD.restoreCommand);
    expect(entry!.metadata!.restoreCommand).toContain("s3cr3t");
    // The provenance half was scrubbed too, and a hand-restore reads it. The null
    // check would have left it, because it is a non-empty string.
    expect(entry!.metadata!.produceCommand).toBe(DSN_PAYLOAD.produceCommand);
  });

  it("reports a scrubbed command with no surviving policy as unrestorable", async () => {
    // The case an operator has to hear about at boot rather than at 3am: the archive
    // exists, the DB says it is a restore point, and the only usable copy of the
    // command went with the policy.
    const run = await seedBackupRun(organizationId, {
      policyId: null,
      artifacts: [brokenArtifact({ metadata: { restoreCommand: SCRUBBED_RESTORE } })],
    });

    const result = await backfillCustomCommandRestoreCommands();
    expect(result.repaired).toBe(0);
    expect(result.unrecoverable).toEqual([run.id]);
    // Not rewritten with a guess.
    const [entry] = await artifactsOf(run.id);
    expect(entry!.metadata!.restoreCommand).toBe(SCRUBBED_RESTORE);
  });

  it("refuses to touch a real command that merely contains ***", async () => {
    // The SQL candidate filter matches any `***` so the scrubbed rows are cheap to
    // find; the narrow re-check is what keeps this from rewriting — or announcing as
    // unrestorable — an operator's own banner. Both halves are asserted, because a
    // false "CANNOT be restored" at boot is its own failure.
    const banner = "echo '*** restoring mail ***'; tar -C /var/vmail -xf -";
    const run = await seedBackupRun(organizationId, {
      policyId: null,
      artifacts: [brokenArtifact({ metadata: { restoreCommand: banner } })],
    });

    // Proven broad, so the skip below is the thing under test and not a vacuous pass:
    // the SQL DOES hand this run to the backfill.
    const candidates = await repos.backupRun.listCustomCommandMissingRestoreCommand();
    expect(candidates.map((r) => r.id)).toContain(run.id);

    expect(await backfillCustomCommandRestoreCommands()).toEqual({
      repaired: 0,
      unrecoverable: [],
    });
    const [entry] = await artifactsOf(run.id);
    expect(entry!.metadata!.restoreCommand).toBe(banner);
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
