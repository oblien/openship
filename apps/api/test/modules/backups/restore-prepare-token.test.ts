/**
 * A re-prepared restore could never be applied.
 *
 * The prepare route mints a confirmation token per REQUEST and hands whatever comes
 * back to the client. `beginPrepare` reuses an already-active restore of the same run
 * — correctly, since two restores of one run would race the staging area — but it used
 * to return only that row's id, so the route replied with the token it had just minted
 * while the row still held the original. Every echo then failed the compare in `apply`.
 *
 * And there was no way out. Re-preparing lands on the SAME reuse branch and hands back
 * another token that also does not match; the dashboard's wizard prepares on open, so
 * an operator who needed a restore had one that was prepared, verified, and unrunnable.
 *
 * The invariant pinned here: what `beginPrepare` RETURNS is what `apply` ACCEPTS.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = "a".repeat(16);
const MINTED = "b".repeat(16);

const h = vi.hoisted(() => ({
  /** The active restore row `findActiveByRunId` answers with. */
  active: {} as Record<string, unknown>,
  /** Tokens `adoptConfirmationToken` was asked to write. */
  adopted: [] as string[],
}));

vi.mock("@repo/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@repo/db")>();
  return {
    ...real,
    repos: {
      ...real.repos,
      backupRun: {
        findById: async () => ({
          id: "bkr_1",
          status: "succeeded",
          destinationId: "dst_1",
          organizationId: "org_1",
          projectId: "prj_1",
          serviceId: "svc_1",
          deletedAt: null,
          artifacts: [],
        }),
      },
      backupDestination: {
        findById: async () => ({ id: "dst_1", organizationId: "org_1", name: "S3" }),
      },
      backupRestore: {
        findActiveByRunId: async () => h.active,
        findById: async () => h.active,
        adoptConfirmationToken: async (_id: string, token: string) => {
          h.adopted.push(token);
          // Mirrors the real conditional write: adopt only into an empty column, and
          // report whichever value ends up in force.
          if (!h.active.confirmationToken) h.active.confirmationToken = token;
          return h.active.confirmationToken as string;
        },
      },
    },
  };
});

import { RestoreOrchestrator } from "../../../src/modules/backups/restore.orchestrator";

const orchestrator = new RestoreOrchestrator();
const ctx = { organizationId: "org_1", userId: "usr_1" } as never;

const prepare = () =>
  orchestrator.beginPrepare({
    runId: "bkr_1",
    trigger: { source: "manual", userId: "usr_1" },
    confirmationToken: MINTED,
  });

/**
 * Whether `apply` got PAST the token compare — without letting it start a real
 * restore. The compare throws before the status check, so a row parked in
 * `preparing` separates the two failures and never reaches `runApply`.
 */
async function applyOutcome(token: string): Promise<"mismatch" | "past-token-check"> {
  h.active.status = "preparing";
  try {
    await orchestrator.apply(ctx, String(h.active.id), token);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/mismatch/i.test(message)) return "mismatch";
    expect(message).toMatch(/must be 'prepared'/);
    return "past-token-check";
  }
  throw new Error("apply resolved — it should have refused a restore in status=preparing");
}

beforeEach(() => {
  h.adopted.length = 0;
  h.active = {
    id: "bks_active",
    runId: "bkr_1",
    organizationId: "org_1",
    status: "prepared",
    confirmationToken: ORIGINAL,
  };
});

describe("beginPrepare on an already-active restore", () => {
  it("returns the token in force, not the one the caller minted", async () => {
    const out = await prepare();
    expect(out.restoreId).toBe("bks_active");
    expect(out.confirmationToken).toBe(ORIGINAL);
    // And left the row alone — the first client is still holding ORIGINAL.
    expect(h.adopted).toEqual([]);
  });

  it("hands back a token apply accepts", async () => {
    const out = await prepare();
    await expect(applyOutcome(out.confirmationToken)).resolves.toBe("past-token-check");
  });

  it("would have handed back one apply rejects — the regression", async () => {
    await prepare();
    await expect(applyOutcome(MINTED)).resolves.toBe("mismatch");
  });

  it("adopts this request's token when the row has none, making apply reachable", async () => {
    h.active.confirmationToken = null;
    const out = await prepare();
    expect(out.confirmationToken).toBe(MINTED);
    expect(h.adopted).toEqual([MINTED]);
    await expect(applyOutcome(MINTED)).resolves.toBe("past-token-check");
  });
});
