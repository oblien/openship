/**
 * Cancelling an applying restore is cooperative, including during project deletion.
 *
 * The request sets the durable flag and aborts the local extract, but the row remains
 * `applying` until the worker unwinds and records its real outcome. A DB-only forced
 * terminal state is not proof the writer stopped; treating it as quiescent lets teardown
 * destroy a volume while the old writer can still mutate it.
 */

import { db, repos, schema } from "@repo/db";
import { beforeEach, describe, expect, it } from "vitest";

import { RestoreOrchestrator } from "../../../src/modules/backups/restore.orchestrator";
import { seedBackupDestination, seedBackupRun, seedOrg, seedProject } from "../../helpers/seed";

let organizationId: string;
let orchestrator: RestoreOrchestrator;
const ctx = () => ({ organizationId, userId: "usr_1" }) as never;

async function seedRestore(status: string, meta: Record<string, unknown> = {}) {
  const projectId = (await seedProject(organizationId)).id;
  const destinationId = (await seedBackupDestination(organizationId)).id;
  const run = await seedBackupRun(organizationId, { destinationId, projectId, artifacts: [] });
  const id = `bks_${status}_${projectId}`;
  await db.insert(schema.backupRestore).values({
    id,
    runId: run.id,
    destinationId,
    projectId,
    organizationId,
    status: status as never,
    confirmationToken: "t".repeat(16),
    meta,
  });
  return id;
}

/**
 * Register an abort handle the way a running apply does. `inFlight` is private to the
 * class, and reaching it is the only way to prove the thing that was actually missing:
 * that the extract is INTERRUPTED, not merely re-labelled.
 */
function registerInFlight(restoreId: string): AbortController {
  const controller = new AbortController();
  (orchestrator as never as { inFlight: Map<string, AbortController> }).inFlight.set(
    restoreId,
    controller,
  );
  return controller;
}

beforeEach(async () => {
  organizationId = (await seedOrg()).organizationId;
  orchestrator = new RestoreOrchestrator();
});

describe("safe cancellation of an applying restore", () => {
  it("keeps the row applying until its worker acknowledges the abort", async () => {
    const id = await seedRestore("applying");

    const outcome = await orchestrator.cancel(ctx(), id);
    expect(outcome).toMatchObject({ accepted: true, status: "applying", forced: false });
    expect(await repos.backupRestore.findById(id)).toMatchObject({
      status: "applying",
      cancelRequested: true,
    });
  });

  it("aborts the in-flight extract rather than only writing the row", async () => {
    const id = await seedRestore("applying");
    const controller = registerInFlight(id);
    await orchestrator.cancel(ctx(), id);
    expect(controller.signal.aborted).toBe(true);
  });

  it("preserves destructive facts without inventing a terminal outcome", async () => {
    const id = await seedRestore("applying", {
      destructive: true,
      destructiveSource: "the volume pgdata",
    });
    const outcome = await orchestrator.cancel(ctx(), id);
    expect(outcome).toMatchObject({ status: "applying", destructive: true, forced: false });

    const row = (await repos.backupRestore.findById(id))!;
    expect(row.status).toBe("applying");
    expect(row.errorMessage).toBeNull();
    expect(row.meta).toEqual({
      destructive: true,
      destructiveSource: "the volume pgdata",
    });
  });

  it("is a no-op on a row that already finished", async () => {
    const id = await seedRestore("succeeded");
    const out = await orchestrator.cancel(ctx(), id);
    expect(out).toMatchObject({ accepted: false, status: "succeeded" });
    expect((await repos.backupRestore.findById(id))!.status).toBe("succeeded");
  });

  it("still refuses a restore from another org", async () => {
    const id = await seedRestore("applying");
    const other = (await seedOrg()).organizationId;
    await expect(
      orchestrator.cancel({ organizationId: other, userId: "usr_2" } as never, id),
    ).rejects.toThrow(/not found/i);
    expect((await repos.backupRestore.findById(id))!.status).toBe("applying");
  });

  it("takes a non-applying restore terminal without needing force at all", async () => {
    const id = await seedRestore("preparing");
    const out = await orchestrator.cancel(ctx(), id);
    expect(out).toMatchObject({ status: "cancelled", forced: false, destructive: false });
  });
});
