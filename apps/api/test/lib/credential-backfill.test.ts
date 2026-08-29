import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Moving `dns_credential` into the generic store is the one place a token is read, re-wrapped
 * and deleted — so what is pinned here is what happens when any step fails.
 *
 * The rule throughout: NEVER delete the only copy of a token we could not carry. An operator
 * who restores a rotated `BETTER_AUTH_SECRET` must still be able to migrate it.
 */

const { dnsRepo, credRepo } = vi.hoisted(() => ({
  dnsRepo: { listAll: vi.fn(), delete: vi.fn(async () => {}) },
  credRepo: { nameTaken: vi.fn(async () => false), create: vi.fn(async () => ({ id: "cred_1" })) },
}));

vi.mock("@repo/db", () => ({ repos: { dnsCredential: dnsRepo, credential: credRepo } }));

const { decrypt } = vi.hoisted(() => ({ decrypt: vi.fn() }));
vi.mock("../../src/lib/credential-encryption", () => ({
  encryptSecretField: (v: string | null | undefined) => (v ? `enc1:${v}` : null),
  decryptSecretField: decrypt,
}));

import { backfillDnsCredentials } from "../../src/lib/startup/credential-backfill";

const legacy = (over: Record<string, unknown> = {}) => ({
  id: "dns_1",
  organizationId: "org_1",
  provider: "cloudflare",
  name: "Cloudflare production",
  apiTokenEnc: "enc1:cf-token",
  status: "active",
  lastVerifiedAt: new Date("2026-01-01"),
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  decrypt.mockImplementation((v: string) => String(v).replace(/^enc1:/, ""));
  dnsRepo.listAll.mockResolvedValue([]);
  credRepo.nameTaken.mockResolvedValue(false);
});

describe("backfillDnsCredentials", () => {
  it("does nothing when there is no legacy row", async () => {
    await expect(backfillDnsCredentials()).resolves.toEqual({ moved: 0, skipped: 0 });
    expect(credRepo.create).not.toHaveBeenCalled();
  });

  it("re-wraps the token as a JSON envelope under the provider's field name", async () => {
    // Not a ciphertext copy: the old envelope wraps the RAW token, the new one a JSON
    // object, so copying bytes would store a secret that parses as neither.
    dnsRepo.listAll.mockResolvedValue([legacy()]);

    await expect(backfillDnsCredentials()).resolves.toEqual({ moved: 1, skipped: 0 });

    const arg = credRepo.create.mock.calls[0]![0] as { secretsEnc: string; provider: string; selector: null };
    expect(arg.provider).toBe("cloudflare");
    // NULL, never "": the unique index folds NULL to '' and two org-wide tokens must not
    // both be storable under one label.
    expect(arg.selector).toBeNull();
    expect(JSON.parse(arg.secretsEnc.replace(/^enc1:/, ""))).toEqual({ apiToken: "cf-token" });
  });

  it("carries status and lastVerifiedAt rather than resetting them", async () => {
    // An operator who saw "invalid" must keep seeing it, and lastVerifiedAt is the only
    // evidence of when the token last worked.
    const when = new Date("2025-06-01");
    dnsRepo.listAll.mockResolvedValue([legacy({ status: "invalid", lastVerifiedAt: when })]);

    await backfillDnsCredentials();

    expect(credRepo.create.mock.calls[0]![0]).toMatchObject({ status: "invalid", lastVerifiedAt: when });
  });

  it("deletes the legacy row only AFTER the new one exists", async () => {
    const order: string[] = [];
    credRepo.create.mockImplementation(async () => {
      order.push("create");
      return { id: "cred_1" };
    });
    dnsRepo.delete.mockImplementation(async () => {
      order.push("delete");
    });
    dnsRepo.listAll.mockResolvedValue([legacy()]);

    await backfillDnsCredentials();

    // A crash between the two must leave a DUPLICATE (absorbed by the name check on the
    // next boot), never zero credentials.
    expect(order).toEqual(["create", "delete"]);
  });

  it("leaves an undecryptable row in place instead of destroying it", async () => {
    // A rotated BETTER_AUTH_SECRET. Deleting here would remove the only copy of a token the
    // operator may still recover by restoring the old secret.
    decrypt.mockImplementation(() => {
      throw new Error("bad key");
    });
    dnsRepo.listAll.mockResolvedValue([legacy()]);

    await expect(backfillDnsCredentials()).resolves.toEqual({ moved: 0, skipped: 1 });
    expect(credRepo.create).not.toHaveBeenCalled();
    expect(dnsRepo.delete).not.toHaveBeenCalled();
  });

  it("leaves a row whose token decrypts to nothing", async () => {
    decrypt.mockReturnValue(undefined);
    dnsRepo.listAll.mockResolvedValue([legacy()]);

    await expect(backfillDnsCredentials()).resolves.toEqual({ moved: 0, skipped: 1 });
    expect(dnsRepo.delete).not.toHaveBeenCalled();
  });

  it("treats an already-migrated label as done and clears the legacy row", async () => {
    // Idempotency: a partial previous run already created the new row, so this must finish
    // the job rather than fail on the unique index forever.
    credRepo.nameTaken.mockResolvedValue(true);
    dnsRepo.listAll.mockResolvedValue([legacy()]);

    await expect(backfillDnsCredentials()).resolves.toEqual({ moved: 1, skipped: 0 });
    expect(credRepo.create).not.toHaveBeenCalled();
    expect(dnsRepo.delete).toHaveBeenCalledWith("org_1", "dns_1");
  });

  it("keeps going when one row fails", async () => {
    // One bad row must not strand the rest — this runs at boot for the whole instance.
    credRepo.create.mockRejectedValueOnce(new Error("insert failed"));
    dnsRepo.listAll.mockResolvedValue([legacy({ id: "dns_1" }), legacy({ id: "dns_2", name: "second" })]);

    await expect(backfillDnsCredentials()).resolves.toEqual({ moved: 1, skipped: 1 });
  });

  it("never throws, so a boot cannot fail on it", async () => {
    dnsRepo.listAll.mockRejectedValue(new Error("db unreachable"));
    await expect(backfillDnsCredentials()).resolves.toEqual({ moved: 0, skipped: 0 });
  });
});
