import { beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_MASK } from "@repo/core";

/**
 * DNS credentials now live in the generic `credential` table — `dns_credential` was one of
 * three places Openship kept a third-party secret. These cases still describe DNS
 * behaviour (zone matching, auth-failure handling, "re-connect" on an undecryptable token);
 * only the store underneath them changed, so the mock moved with it.
 */
const credentialRepo = vi.hoisted(() => ({
  listByOrg: vi.fn(),
  findById: vi.fn(),
  findActive: vi.fn(),
  listActiveByProvider: vi.fn(),
  create: vi.fn(),
  update: vi.fn(async () => {}),
  markVerified: vi.fn(async () => {}),
  markInvalid: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  nameTaken: vi.fn(async () => false),
}));

vi.mock("@repo/db", () => ({ repos: { credential: credentialRepo } }));

const decrypt = vi.hoisted(() => vi.fn());
vi.mock("../../../src/lib/credential-encryption", () => ({
  encryptSecretField: (v: string | null | undefined) => (v ? `enc1:${v}` : null),
  decryptSecretField: decrypt,
}));

const provider = vi.hoisted(() => ({
  name: "cloudflare" as const,
  descriptor: {
    name: "cloudflare" as const,
    displayName: "Cloudflare",
    description: "",
    requiredScopes: [],
  },
  preflight: vi.fn(),
  findZone: vi.fn(),
  listRecords: vi.fn(),
  upsertRecord: vi.fn(),
  deleteRecord: vi.fn(),
}));

vi.mock("../../../src/modules/dns/registry", () => ({
  resolveDnsProvider: () => provider,
  listDnsProviders: () => ["cloudflare"],
  describeDnsProviders: () => [provider.descriptor],
}));

const {
  sanitizeCredential,
  listCredentials,
  resolveDnsManager,
  planRecords,
  provisionRecords,
  releaseRecords,
} = await import("../../../src/modules/dns/dns-credential.service");
const { DnsApiError, OPENSHIP_RECORD_COMMENT } = await import("../../../src/modules/dns/types");

const row = (over: Record<string, unknown> = {}) => ({
  id: "dns_1",
  organizationId: "org_1",
  provider: "cloudflare",
  name: "Cloudflare production",
  // One `enc1:` envelope over a JSON object, keyed by the provider's field name — the
  // shape that lets a provider hold several secrets without new columns.
  secretsEnc: `enc1:${JSON.stringify({ apiToken: "cf-token" })}`,
  publicFields: {},
  selector: null,
  status: "active",
  lastVerifiedAt: new Date("2026-01-01"),
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  ...over,
});

const rec = (over: Record<string, unknown> = {}) => ({
  id: "rec_1",
  zoneId: "zone_1",
  type: "A" as const,
  name: "app.example.com",
  content: "192.0.2.1",
  ttl: 1,
  proxied: false,
  comment: OPENSHIP_RECORD_COMMENT,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  decrypt.mockImplementation((v: string) => String(v).replace(/^enc1:/, ""));
  provider.findZone.mockResolvedValue({ id: "zone_1", name: "example.com", status: "active" });
});

describe("credential sanitization", () => {
  it("returns a constant mask and never decrypts on a read path", async () => {
    credentialRepo.listByOrg.mockResolvedValue([row()]);

    const [out] = await listCredentials("org_1");

    expect(out?.tokenMasked).toBe(ENV_MASK);
    // The whole reason the mask is a constant: a read endpoint must not be a
    // partial-token disclosure, and it must not be able to throw on a rotated key.
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("does not leak the ciphertext either", () => {
    const out = sanitizeCredential(row() as never) as unknown as Record<string, unknown>;
    expect(JSON.stringify(out)).not.toContain("cf-token");
    expect(out.apiTokenEnc).toBeUndefined();
  });

  it("survives a rotated encryption key instead of 500ing the list", async () => {
    decrypt.mockImplementation(() => {
      throw new Error("Unsupported state or unable to authenticate data");
    });
    credentialRepo.listByOrg.mockResolvedValue([row()]);

    await expect(listCredentials("org_1")).resolves.toHaveLength(1);
  });
});

describe("resolveDnsManager", () => {
  it("reports 'none' when the org has no credentials", async () => {
    credentialRepo.listActiveByProvider.mockResolvedValue([]);
    expect(await resolveDnsManager("org_1", "app.example.com")).toEqual({ status: "none" });
  });

  it("matches the credential whose zone hosts the name", async () => {
    credentialRepo.listActiveByProvider.mockResolvedValue([row()]);
    const out = await resolveDnsManager("org_1", "app.example.com");
    expect(out.status).toBe("matched");
    if (out.status === "matched") expect(out.manager.zone.name).toBe("example.com");
  });

  it("distinguishes 'unavailable' from 'none' on a rate limit", async () => {
    // A 429 reported as "no provider manages this" reads as a config mistake the
    // operator did not make, and silently skips provisioning.
    credentialRepo.listActiveByProvider.mockResolvedValue([row()]);
    provider.findZone.mockRejectedValue(new DnsApiError("cloudflare", 429, "Rate limited"));

    const out = await resolveDnsManager("org_1", "app.example.com");
    expect(out.status).toBe("unavailable");
  });

  it("reports 'unauthorized' with the credential id on a 401", async () => {
    credentialRepo.listActiveByProvider.mockResolvedValue([row()]);
    provider.findZone.mockRejectedValue(new DnsApiError("cloudflare", 401, "Invalid token"));

    const out = await resolveDnsManager("org_1", "app.example.com");
    expect(out.status).toBe("unauthorized");
    if (out.status === "unauthorized") expect(out.credentialId).toBe("dns_1");
  });

  it("treats an undecryptable token as unauthorized, not as a crash", async () => {
    credentialRepo.listActiveByProvider.mockResolvedValue([row()]);
    decrypt.mockImplementation(() => {
      throw new Error("bad key");
    });

    const out = await resolveDnsManager("org_1", "app.example.com");
    expect(out.status).toBe("unauthorized");
  });

  it("keeps looking past one broken credential to a working one", async () => {
    credentialRepo.listActiveByProvider.mockResolvedValue([
      row({ id: "dns_broken" }),
      row({ id: "dns_good" }),
    ]);
    provider.findZone
      .mockRejectedValueOnce(new DnsApiError("cloudflare", 401, "Invalid token"))
      .mockResolvedValueOnce({ id: "zone_1", name: "example.com", status: "active" });

    const out = await resolveDnsManager("org_1", "app.example.com");
    expect(out.status).toBe("matched");
    if (out.status === "matched") expect(out.manager.credentialId).toBe("dns_good");
  });
});

describe("planRecords", () => {
  beforeEach(() => credentialRepo.listActiveByProvider.mockResolvedValue([row()]));

  const plan1 = (over: Record<string, unknown> = {}) =>
    planRecords("org_1", "app.example.com", [
      { type: "A", name: "app.example.com", content: "192.0.2.1", ...over },
    ]);

  it("classifies an empty zone as create — nothing is there yet", async () => {
    provider.listRecords.mockResolvedValue([]);
    const out = await plan1();
    expect(out.status).toBe("matched");
    expect(out.records[0]?.action).toBe("create");
    expect(provider.upsertRecord).not.toHaveBeenCalled();
  });

  it("classifies a matching record as in-sync so apply can skip it", async () => {
    provider.listRecords.mockResolvedValue([rec({ content: "192.0.2.1" })]);
    const out = await plan1();
    expect(out.records[0]?.action).toBe("in-sync");
    expect(out.records[0]?.current).toBe("192.0.2.1");
  });

  it("classifies our own stale record as update — safe to rewrite in place", async () => {
    provider.listRecords.mockResolvedValue([rec({ content: "192.0.2.99" })]);
    const out = await plan1();
    expect(out.records[0]?.action).toBe("update");
    expect(out.records[0]?.current).toBe("192.0.2.99");
  });

  it("classifies a single foreign record as adopt — a consented repoint", async () => {
    provider.listRecords.mockResolvedValue([
      rec({ content: "192.0.2.99", comment: undefined }),
    ]);
    const out = await plan1();
    expect(out.records[0]?.action).toBe("adopt");
  });

  it("classifies multiple foreign records as conflict — never silently overwritten", async () => {
    // A round-robin A set the operator maintains: apply must refuse, not pick one.
    provider.listRecords.mockResolvedValue([
      rec({ id: "a", comment: undefined, content: "192.0.2.2" }),
      rec({ id: "b", comment: undefined, content: "192.0.2.3" }),
    ]);
    const out = await plan1();
    expect(out.records[0]?.action).toBe("conflict");
  });

  it("returns 'none' with no records when no connected provider hosts the zone", async () => {
    credentialRepo.listActiveByProvider.mockResolvedValue([]);
    const out = await plan1();
    expect(out).toEqual({ status: "none", records: [] });
    expect(provider.listRecords).not.toHaveBeenCalled();
  });

  it("drops value-less records — there is nothing to plan for an unknown target", async () => {
    const out = await planRecords("org_1", "app.example.com", [
      { type: "CNAME", name: "app.example.com", content: "" },
    ]);
    expect(out).toEqual({ status: "none", records: [] });
    expect(provider.findZone).not.toHaveBeenCalled();
  });

  it("collapses an auth failure during the check to 'unauthorized', not a half-plan", async () => {
    provider.listRecords.mockRejectedValue(new DnsApiError("cloudflare", 401, "Invalid token"));
    credentialRepo.markInvalid.mockResolvedValue(undefined);
    const out = await plan1();
    expect(out.status).toBe("unauthorized");
    expect(out.records).toEqual([]);
  });
});

describe("provisionRecords", () => {
  beforeEach(() => {
    credentialRepo.listActiveByProvider.mockResolvedValue([row()]);
    // Default: the zone is empty, so every desired record classifies as "create"
    // and reaches the check-before-set upsert. Cases that need an existing record
    // override this per-test.
    provider.listRecords.mockResolvedValue([]);
  });

  it("skips a record already in place instead of rewriting it", async () => {
    provider.listRecords.mockResolvedValue([rec({ content: "192.0.2.1" })]);

    const out = await provisionRecords("org_1", "app.example.com", [
      { type: "A", name: "app.example.com", content: "192.0.2.1" },
    ]);

    expect(provider.upsertRecord).not.toHaveBeenCalled();
    expect(out.records[0]).toMatchObject({ outcome: "skipped", action: "in-sync" });
    // Idempotent apply is still a success: everything the operator asked for is live.
    expect(out.provisioned).toBe(true);
  });

  it("REFUSES a conflict rather than clobbering records it does not own", async () => {
    provider.listRecords.mockResolvedValue([
      rec({ id: "a", comment: undefined, content: "192.0.2.2" }),
      rec({ id: "b", comment: undefined, content: "192.0.2.3" }),
    ]);

    const out = await provisionRecords("org_1", "app.example.com", [
      { type: "A", name: "app.example.com", content: "192.0.2.1" },
    ]);

    expect(provider.upsertRecord).not.toHaveBeenCalled();
    expect(out.records[0]).toMatchObject({ outcome: "failed", action: "conflict" });
    expect(out.provisioned).toBe(false);
  });

  it("writes every desired record and reports provisioned", async () => {
    provider.upsertRecord.mockResolvedValue(rec());

    const out = await provisionRecords("org_1", "app.example.com", [
      { type: "A", name: "app.example.com", content: "192.0.2.1" },
      { type: "TXT", name: "_openship-challenge.app.example.com", content: "tok" },
    ]);

    expect(provider.upsertRecord).toHaveBeenCalledTimes(2);
    expect(out.provisioned).toBe(true);
    expect(out.records.every((r) => r.outcome === "applied")).toBe(true);
  });

  it("skips a record whose value is unknown rather than writing an empty one", async () => {
    provider.upsertRecord.mockResolvedValue(rec());

    const out = await provisionRecords("org_1", "app.example.com", [
      { type: "CNAME", name: "app.example.com", content: "" },
      { type: "TXT", name: "_openship-challenge.app.example.com", content: "tok" },
    ]);

    expect(provider.upsertRecord).toHaveBeenCalledTimes(1);
    expect(out.records[0]?.outcome).toBe("skipped");
  });

  it("ATTEMPTS every record even after one is rejected", async () => {
    // One bad value must not suppress the ownership TXT that would let the
    // domain verify.
    provider.upsertRecord
      .mockRejectedValueOnce(new DnsApiError("cloudflare", 400, "Content invalid"))
      .mockResolvedValueOnce(rec());

    const out = await provisionRecords("org_1", "app.example.com", [
      { type: "A", name: "app.example.com", content: "not-an-ip" },
      { type: "TXT", name: "_openship-challenge.app.example.com", content: "tok" },
    ]);

    expect(provider.upsertRecord).toHaveBeenCalledTimes(2);
    expect(out.provisioned).toBe(false);
    expect(out.records.map((r) => r.outcome)).toEqual(["failed", "applied"]);
    // A partial write is reportable, not indistinguishable from "nothing happened".
    expect(out.reason).toContain("1 of 2");
  });

  it("marks the credential invalid when the provider rejects the token", async () => {
    provider.findZone.mockRejectedValue(new DnsApiError("cloudflare", 403, "Forbidden"));
    credentialRepo.markInvalid.mockResolvedValue(undefined);

    const out = await provisionRecords("org_1", "app.example.com", [
      { type: "A", name: "app.example.com", content: "192.0.2.1" },
    ]);

    expect(credentialRepo.markInvalid).toHaveBeenCalledWith(
      "org_1",
      "dns_1",
      expect.stringContaining("rejected"),
    );
    expect(out.provisioned).toBe(false);
  });

  it("does NOT mark a credential invalid when the provider was merely unreachable", async () => {
    provider.findZone.mockRejectedValue(new DnsApiError("cloudflare", 503, "Bad gateway"));

    await provisionRecords("org_1", "app.example.com", [
      { type: "A", name: "app.example.com", content: "192.0.2.1" },
    ]);

    expect(credentialRepo.markInvalid).not.toHaveBeenCalled();
  });

  it("does not reject when marking the credential invalid fails", async () => {
    provider.findZone.mockRejectedValue(new DnsApiError("cloudflare", 401, "nope"));
    credentialRepo.markInvalid.mockRejectedValue(new Error("db gone"));

    await expect(
      provisionRecords("org_1", "app.example.com", [
        { type: "A", name: "app.example.com", content: "192.0.2.1" },
      ]),
    ).resolves.toMatchObject({ provisioned: false });
  });
});

describe("releaseRecords", () => {
  beforeEach(() => credentialRepo.listActiveByProvider.mockResolvedValue([row()]));

  it("deletes ONLY records carrying our ownership marker", async () => {
    // The apex of a custom domain IS the zone apex. Name-matching alone would
    // take the operator's MX and SPF with it.
    provider.listRecords.mockResolvedValue([
      rec({ id: "rec_ours", type: "A", comment: OPENSHIP_RECORD_COMMENT }),
      rec({ id: "rec_mx", type: "MX", comment: undefined, content: "mail.example.com" }),
      rec({ id: "rec_spf", type: "TXT", comment: "operator's SPF", content: "v=spf1 -all" }),
    ]);
    provider.deleteRecord.mockResolvedValue(undefined);

    const out = await releaseRecords("org_1", "example.com", ["example.com"]);

    expect(out.deleted).toBe(1);
    expect(provider.deleteRecord).toHaveBeenCalledTimes(1);
    expect(provider.deleteRecord).toHaveBeenCalledWith(expect.anything(), "zone_1", "rec_ours");
  });

  it("deletes nothing when the zone holds only the operator's records", async () => {
    provider.listRecords.mockResolvedValue([rec({ id: "rec_mx", comment: undefined })]);

    const out = await releaseRecords("org_1", "example.com", ["example.com"]);

    expect(out.deleted).toBe(0);
    expect(provider.deleteRecord).not.toHaveBeenCalled();
  });

  it("de-duplicates the requested names", async () => {
    provider.listRecords.mockResolvedValue([]);
    await releaseRecords("org_1", "example.com", ["example.com", "example.com"]);
    expect(provider.listRecords).toHaveBeenCalledTimes(1);
  });

  it("reports a reason instead of throwing when the provider is unreachable", async () => {
    // A domain must stay removable from Openship when Cloudflare is down.
    provider.listRecords.mockRejectedValue(new DnsApiError("cloudflare", 503, "unavailable"));

    const out = await releaseRecords("org_1", "example.com", ["example.com"]);

    expect(out.deleted).toBe(0);
    expect(out.reason).toContain("503");
  });

  it("is a no-op when no connected provider hosts the zone", async () => {
    provider.findZone.mockResolvedValue(null);

    const out = await releaseRecords("org_1", "example.com", ["example.com"]);

    expect(out).toEqual({ deleted: 0 });
    expect(provider.listRecords).not.toHaveBeenCalled();
  });
});
