/**
 * A custom_command policy with no `restoreCommand` captures dead artifacts.
 *
 * `CustomCommandProducer.produce` records `restoreCommand: opts.restoreCommand ?? null`
 * and `restore` refuses on that null forever — and nothing downstream can reconstruct
 * the command, because only the policy ever knew it. So a policy saved without one
 * produces runs that report `succeeded` with real bytes at the destination, list as
 * restore points indefinitely, and refuse at the one moment somebody needs them. The
 * boot backfill cannot help either: it re-derives the value FROM THE POLICY.
 *
 * The dashboard's editor had exactly one command box, so every custom policy created
 * there was in that state. The form now has both boxes, but the form is not the only
 * caller — the REST API, the MCP tools and the CLI reach `createPolicy` directly — so
 * the refusal lives at the service, and these tests drive it there.
 *
 * The counterweight is the second half: an operator must still be able to DISABLE a
 * policy that predates the guard. Refusing to let them turn off an unrestorable policy
 * would be worse than the bug.
 */

import { repos, schema, db } from "@repo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ syncPolicySchedule: vi.fn() }));

// Registering a real cron schedule is the JobRunner's business, not this guard's.
vi.mock("../../../src/modules/backups/triggers/cron", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../src/modules/backups/triggers/cron")>()),
  syncPolicySchedule: h.syncPolicySchedule,
}));

import { createPolicy, updatePolicy } from "../../../src/modules/backups/backup.service";
import {
  seedBackupDestination,
  seedBackupPolicy,
  seedOrg,
  seedProject,
} from "../../helpers/seed";

const ctx = (organizationId: string, userId: string) => ({ organizationId, userId }) as never;

const PRODUCE = 'mongodump --uri "mongodb://root:s3cr3t@db:27017/?authSource=admin" --archive';
const RESTORE = 'mongorestore --uri "mongodb://root:s3cr3t@db:27017/?authSource=admin" --archive';

let organizationId: string;
let userId: string;
let projectId: string;
let destinationId: string;

beforeEach(async () => {
  vi.clearAllMocks();
  await db.delete(schema.backupPolicy);
  const org = await seedOrg();
  organizationId = org.organizationId;
  userId = org.userId;
  projectId = (await seedProject(organizationId)).id;
  destinationId = (await seedBackupDestination(organizationId)).id;
});

const create = (payloadKind: string, payloadConfig?: Record<string, unknown>) =>
  createPolicy(ctx(organizationId, userId), {
    projectId,
    serviceId: null,
    destinationId,
    payloadKind,
    payloadConfig,
  });

describe("createPolicy refuses a custom_command policy it could never restore", () => {
  it("rejects a produce command with no restore command", async () => {
    await expect(create("custom_command", { produceCommand: PRODUCE })).rejects.toThrow(
      /restoreCommand/,
    );
    // And wrote nothing — a half-saved policy would still capture dead artifacts.
    expect(await repos.backupPolicy.listByProject(projectId)).toHaveLength(0);
  });

  it("rejects the dashboard's legacy `command` key with no restore command", async () => {
    await expect(create("custom_command", { command: PRODUCE })).rejects.toThrow(
      /restoreCommand/,
    );
  });

  it("rejects an empty / whitespace restore command, not just a missing key", async () => {
    await expect(
      create("custom_command", { produceCommand: PRODUCE, restoreCommand: "   " }),
    ).rejects.toThrow(/restoreCommand/);
  });

  it("names the PRODUCE half when that is the one missing", async () => {
    await expect(create("custom_command", { restoreCommand: RESTORE })).rejects.toThrow(
      /produceCommand/,
    );
  });

  it("accepts both halves and stores them verbatim", async () => {
    const row = await create("custom_command", {
      produceCommand: PRODUCE,
      restoreCommand: RESTORE,
    });
    expect(row.payloadConfig).toMatchObject({
      produceCommand: PRODUCE,
      restoreCommand: RESTORE,
    });
  });

  it("accepts the legacy `command` key when a restore command is present", async () => {
    // The producer reads `produceCommand ?? command`, so this policy captures fine.
    // Refusing it would break every pre-existing API caller for no gain.
    const row = await create("custom_command", { command: PRODUCE, restoreCommand: RESTORE });
    expect(row.payloadConfig).toMatchObject({ command: PRODUCE });
  });

  it("leaves auto and volume policies alone", async () => {
    await expect(create("auto", undefined)).resolves.toBeTruthy();
    await expect(create("volume", { sourceIds: ["vol_a"] })).resolves.toBeTruthy();
  });
});

describe("updatePolicy guards the payload without trapping an existing policy", () => {
  /** A policy in the broken state the dashboard used to create. */
  const seedUnrestorable = () =>
    seedBackupPolicy(destinationId, {
      projectId,
      payloadKind: "custom_command",
      payloadConfig: { command: PRODUCE },
    });

  it("refuses a patch that re-saves the payload without a restore command", async () => {
    const policy = await seedUnrestorable();
    await expect(
      updatePolicy(ctx(organizationId, userId), policy.id, {
        payloadKind: "custom_command",
        payloadConfig: { produceCommand: PRODUCE },
      }),
    ).rejects.toThrow(/restoreCommand/);
  });

  it("still lets an operator DISABLE a policy that predates the guard", async () => {
    const policy = await seedUnrestorable();
    const updated = await updatePolicy(ctx(organizationId, userId), policy.id, {
      enabled: false,
    });
    expect(updated!.enabled).toBe(false);
  });

  it("still lets unrelated fields be edited on such a policy", async () => {
    const policy = await seedUnrestorable();
    const updated = await updatePolicy(ctx(organizationId, userId), policy.id, {
      cronExpression: "17 3 * * *",
      retainCount: 3,
    });
    expect(updated!.retainCount).toBe(3);
  });

  it("refuses a config-only patch that strips the restore command off a good policy", async () => {
    const policy = await seedBackupPolicy(destinationId, {
      projectId,
      payloadKind: "custom_command",
      payloadConfig: { produceCommand: PRODUCE, restoreCommand: RESTORE },
    });
    // No payloadKind in the patch: the effective kind has to come off the ROW, or a
    // caller could drop the command by simply omitting the field the guard keys on.
    await expect(
      updatePolicy(ctx(organizationId, userId), policy.id, {
        payloadConfig: { produceCommand: PRODUCE },
      }),
    ).rejects.toThrow(/restoreCommand/);
    const after = await repos.backupPolicy.findById(policy.id);
    expect((after!.payloadConfig as { restoreCommand?: string }).restoreCommand).toBe(RESTORE);
  });

  it("allows switching a custom policy to volume without re-supplying commands", async () => {
    const policy = await seedUnrestorable();
    const updated = await updatePolicy(ctx(organizationId, userId), policy.id, {
      payloadKind: "volume",
    });
    expect(updated!.payloadKind).toBe("volume");
  });
});
