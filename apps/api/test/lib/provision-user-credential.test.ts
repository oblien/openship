import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  committed: [] as Array<Array<{ table: string; values: Record<string, unknown> }>>,
  failCredential: false,
  transactionCalls: 0,
}));

vi.mock("@repo/core", () => ({
  generateId: (prefix: string) => `${prefix}_generated`,
}));

vi.mock("@repo/db", () => {
  const schema = {
    user: { _name: "user", id: "user.id" },
    organization: { _name: "organization", id: "organization.id" },
    member: { _name: "member" },
    account: { _name: "account" },
  };
  const db = {
    transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
      h.transactionCalls += 1;
      const staged: Array<{ table: string; values: Record<string, unknown> }> = [];
      const tx = {
        insert: (table: { _name: string }) => ({
          values: (values: Record<string, unknown>) => {
            if (table === schema.account && h.failCredential) {
              throw new Error("credential insert failed");
            }
            staged.push({ table: table._name, values });
            return {
              onConflictDoNothing: async () => undefined,
            };
          },
        }),
      };
      try {
        const result = await run(tx);
        h.committed.push(staged);
        return result;
      } catch (error) {
        // Model database rollback: staged writes never become committed.
        throw error;
      }
    }),
  };
  return { db, schema };
});

import { provisionUserWithCredential } from "@repo/platform/engine/lib/provision-user";

beforeEach(() => {
  h.committed = [];
  h.failCredential = false;
  h.transactionCalls = 0;
});

describe("provisionUserWithCredential", () => {
  it("commits user, personal org, owner membership, and credential together", async () => {
    await expect(
      provisionUserWithCredential(
        {
          id: "usr_invited",
          name: "Invited User",
          email: "invited@example.com",
          emailVerified: true,
        },
        { passwordHash: "hashed-secret", accountId: "acc_fixed" },
      ),
    ).resolves.toBe("org_usr_invited");

    expect(h.transactionCalls).toBe(1);
    expect(h.committed).toHaveLength(1);
    expect(h.committed[0].map((write) => write.table)).toEqual([
      "user",
      "organization",
      "member",
      "account",
    ]);
    expect(h.committed[0][3].values).toMatchObject({
      id: "acc_fixed",
      accountId: "usr_invited",
      providerId: "credential",
      userId: "usr_invited",
      password: "hashed-secret",
    });
  });

  it("rolls every identity row back when credential creation fails", async () => {
    h.failCredential = true;

    await expect(
      provisionUserWithCredential(
        { id: "usr_partial", name: "Partial", email: "partial@example.com" },
        { passwordHash: "hashed-secret" },
      ),
    ).rejects.toThrow("credential insert failed");

    expect(h.transactionCalls).toBe(1);
    expect(h.committed).toEqual([]);
  });
});
