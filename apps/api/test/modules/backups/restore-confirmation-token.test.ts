/**
 * `adoptConfirmationToken` — repair a restore row that can never be applied.
 *
 * `apply` compares the supplied token against the stored one with an exact,
 * length-guarded `timingSafeEqual`, and the route rejects an empty token before it
 * gets that far. So a row whose `confirmation_token` is NULL is not merely strict —
 * it is unappliable, permanently, no matter what the client sends. The only escape
 * was to cancel and start over, and a restore reached that state simply by being
 * prepared twice (see restore-prepare-token.test.ts for that half).
 *
 * The write is conditional on the column still being null so a concurrent prepare
 * cannot swap the token out from under a client that is already holding one — which
 * is why the losing caller gets a READ-BACK of the winner's value rather than its own.
 */

import { db, repos, schema } from "@repo/db";
import { beforeEach, describe, expect, it } from "vitest";

import { seedBackupDestination, seedBackupRun, seedOrg, seedProject } from "../../helpers/seed";

const ORIGINAL = "a".repeat(16);
const MINTED = "b".repeat(16);

let organizationId: string;

/** A prepared restore row whose confirmation token starts at `token`. */
async function seedRestore(token: string | null) {
  const projectId = (await seedProject(organizationId)).id;
  const destinationId = (await seedBackupDestination(organizationId)).id;
  const run = await seedBackupRun(organizationId, { destinationId, projectId, artifacts: [] });
  const id = `bks_${organizationId}_${token ?? "null"}`;
  await db.insert(schema.backupRestore).values({
    id,
    runId: run.id,
    destinationId,
    projectId,
    organizationId,
    status: "prepared",
    confirmationToken: token,
  });
  return id;
}

beforeEach(async () => {
  organizationId = (await seedOrg()).organizationId;
});

describe("backupRestore.adoptConfirmationToken", () => {
  it("fills in a null token and reports the value it wrote", async () => {
    const id = await seedRestore(null);
    expect(await repos.backupRestore.adoptConfirmationToken(id, MINTED)).toBe(MINTED);
    expect((await repos.backupRestore.findById(id))!.confirmationToken).toBe(MINTED);
  });

  it("does NOT overwrite a token already in force, and reports the one that is", async () => {
    const id = await seedRestore(ORIGINAL);
    // Swapping ORIGINAL out here would break a restore that works in order to fix
    // one that doesn't: the client that prepared first is still holding it.
    expect(await repos.backupRestore.adoptConfirmationToken(id, MINTED)).toBe(ORIGINAL);
    expect((await repos.backupRestore.findById(id))!.confirmationToken).toBe(ORIGINAL);
  });

  it("is idempotent — a second adopt of the same token is a no-op", async () => {
    const id = await seedRestore(null);
    await repos.backupRestore.adoptConfirmationToken(id, MINTED);
    expect(await repos.backupRestore.adoptConfirmationToken(id, ORIGINAL)).toBe(MINTED);
  });

  it("reports null for a row that does not exist rather than throwing", async () => {
    // beginPrepare turns this into an actionable error; a throw from the repo would
    // surface as an unhandled 500 on a route whose whole job is to be recoverable.
    expect(await repos.backupRestore.adoptConfirmationToken("bks_nope", MINTED)).toBeNull();
  });
});
