import "./_setup-env";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The provider primitives and the SSH-backed state reads are covered elsewhere;
// this file guards ONLY the mail→provider mapping and the ack-on-success rule.
const planRecords = vi.fn().mockResolvedValue({ status: "none", records: [] });
const provisionRecords = vi.fn();
vi.mock("../../../src/modules/dns/dns-credential.service", () => ({
  planRecords: (...a: unknown[]) => planRecords(...a),
  provisionRecords: (...a: unknown[]) => provisionRecords(...a),
}));

const getDomainDnsState = vi.fn();
const acknowledgeDomainDns = vi.fn().mockResolvedValue(undefined);
vi.mock("../../../src/modules/mail/admin/domain-dns.service", () => ({
  getDomainDnsState: (...a: unknown[]) => getDomainDnsState(...a),
  acknowledgeDomainDns: (...a: unknown[]) => acknowledgeDomainDns(...a),
}));

const { planMailDomainDns, applyMailDomainDns } = await import(
  "../../../src/modules/mail/admin/domain-dns-provider.service"
);

const recordSet = (over: Record<string, unknown> = {}) => ({
  mx: { type: "MX", name: "example.com", value: "mail.example.com", priority: 10 },
  spf: { type: "TXT", name: "example.com", value: "v=spf1 mx -all" },
  dmarc: { type: "TXT", name: "_dmarc.example.com", value: "v=DMARC1; p=none" },
  ...over,
});

const state = (records: Record<string, unknown>) => ({
  records,
  acknowledgedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("mail domain DNS plan/apply mapping", () => {
  beforeEach(() => {
    planRecords.mockClear();
    provisionRecords.mockReset();
    getDomainDnsState.mockReset();
    acknowledgeDomainDns.mockClear();
  });

  it("maps the persisted record set to provider inputs, carrying MX priority", async () => {
    getDomainDnsState.mockResolvedValue(state(recordSet()));

    await planMailDomainDns("org_1", "srv_1", "example.com");

    expect(planRecords).toHaveBeenCalledTimes(1);
    const [org, domain, inputs] = planRecords.mock.calls[0] as [string, string, any[]];
    expect(org).toBe("org_1");
    expect(domain).toBe("example.com");
    // MX must keep its preference — Cloudflare rejects an MX create without one.
    expect(inputs).toContainEqual({
      type: "MX",
      name: "example.com",
      content: "mail.example.com",
      priority: 10,
    });
    expect(inputs).toContainEqual({ type: "TXT", name: "example.com", content: "v=spf1 mx -all" });
    expect(inputs).toContainEqual({
      type: "TXT",
      name: "_dmarc.example.com",
      content: "v=DMARC1; p=none",
    });
  });

  it("includes DKIM only when a key has been generated for the domain", async () => {
    getDomainDnsState.mockResolvedValue(
      state(
        recordSet({
          dkim: { type: "TXT", name: "dkim._domainkey.example.com", value: "v=DKIM1; p=MIGf" },
        }),
      ),
    );

    await planMailDomainDns("org_1", "srv_1", "example.com");
    const inputs = (planRecords.mock.calls[0] as any[])[2] as any[];
    expect(inputs.some((r) => r.name === "dkim._domainkey.example.com")).toBe(true);
  });

  it("omits DKIM when no key exists — no empty record is planned", async () => {
    getDomainDnsState.mockResolvedValue(
      state(recordSet({ dkim: { type: "TXT", name: "dkim._domainkey.example.com", value: "" } })),
    );

    await planMailDomainDns("org_1", "srv_1", "example.com");
    const inputs = (planRecords.mock.calls[0] as any[])[2] as any[];
    expect(inputs.some((r) => r.name === "dkim._domainkey.example.com")).toBe(false);
  });

  it("threads the relay send-hop extraRecords through", async () => {
    getDomainDnsState.mockResolvedValue(
      state(
        recordSet({
          extraRecords: [
            { type: "CNAME", name: "abc._domainkey.example.com", value: "abc.dkim.amazonses.com" },
          ],
        }),
      ),
    );

    await planMailDomainDns("org_1", "srv_1", "example.com");
    const inputs = (planRecords.mock.calls[0] as any[])[2] as any[];
    expect(inputs).toContainEqual({
      type: "CNAME",
      name: "abc._domainkey.example.com",
      content: "abc.dkim.amazonses.com",
    });
  });

  it("plans nothing for a domain with no saved DNS state", async () => {
    getDomainDnsState.mockResolvedValue(null);

    await planMailDomainDns("org_1", "srv_1", "example.com");
    expect((planRecords.mock.calls[0] as any[])[2]).toEqual([]);
  });

  it("clears the manual banner (acks) only when apply fully succeeds", async () => {
    getDomainDnsState.mockResolvedValue(state(recordSet()));
    provisionRecords.mockResolvedValue({ provisioned: true, records: [] });

    await applyMailDomainDns("org_1", "srv_1", "example.com");

    expect(acknowledgeDomainDns).toHaveBeenCalledWith("srv_1", "example.com");
  });

  it("does NOT ack when apply was partial — the banner must stay up", async () => {
    getDomainDnsState.mockResolvedValue(state(recordSet()));
    provisionRecords.mockResolvedValue({ provisioned: false, records: [] });

    await applyMailDomainDns("org_1", "srv_1", "example.com");

    expect(acknowledgeDomainDns).not.toHaveBeenCalled();
  });

  it("a failed ack does not fail the apply — the records are already live", async () => {
    getDomainDnsState.mockResolvedValue(state(recordSet()));
    provisionRecords.mockResolvedValue({ provisioned: true, records: [] });
    acknowledgeDomainDns.mockRejectedValueOnce(new Error("state file gone"));

    await expect(applyMailDomainDns("org_1", "srv_1", "example.com")).resolves.toMatchObject({
      provisioned: true,
    });
  });
});
