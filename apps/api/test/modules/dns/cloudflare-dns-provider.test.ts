import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cloudflareDnsProvider } from "../../../src/modules/dns/providers/cloudflare.provider";
import {
  DnsApiError,
  DnsRecordConflictError,
  OPENSHIP_RECORD_COMMENT,
  isOpenshipManaged,
} from "../../../src/modules/dns/types";

/** Shape a Cloudflare v4 envelope the way the real API does. */
function cfOk(result: unknown, resultInfo?: Record<string, number>) {
  return {
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result,
        ...(resultInfo ? { result_info: resultInfo } : {}),
      }),
  } as Response;
}

function cfErr(status: number, message: string) {
  return {
    ok: false,
    status,
    text: async () =>
      JSON.stringify({
        success: false,
        errors: [{ code: 1000, message }],
        messages: [],
        result: null,
      }),
  } as Response;
}

const record = (over: Record<string, unknown> = {}) => ({
  id: "rec_1",
  zone_id: "zone_123",
  type: "A",
  name: "app.example.com",
  content: "198.51.100.1",
  ttl: 1,
  proxied: false,
  comment: OPENSHIP_RECORD_COMMENT,
  ...over,
});

describe("cloudflareDnsProvider", () => {
  const originalFetch = global.fetch;

  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("preflight", () => {
    it("fails when the token is blank", async () => {
      const result = await cloudflareDnsProvider.preflight({ apiToken: "   " });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("missing");
    });

    it("accepts an active token", async () => {
      global.fetch = vi.fn().mockResolvedValue(cfOk({ id: "tok_1", status: "active" }));
      const result = await cloudflareDnsProvider.preflight({ apiToken: "valid" });
      expect(result.ok).toBe(true);
    });

    it("reports the status back when the token is not active", async () => {
      global.fetch = vi.fn().mockResolvedValue(cfOk({ id: "tok_1", status: "disabled" }));
      const result = await cloudflareDnsProvider.preflight({ apiToken: "disabled" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("disabled");
    });

    it("turns a 403 into scope guidance rather than a raw API string", async () => {
      global.fetch = vi.fn().mockResolvedValue(cfErr(403, "Invalid request headers"));
      const result = await cloudflareDnsProvider.preflight({ apiToken: "underscoped" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("DNS:Edit");
    });

    it("does not throw when the network is down", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
      const result = await cloudflareDnsProvider.preflight({ apiToken: "x" });
      expect(result.ok).toBe(false);
    });
  });

  describe("findZone", () => {
    it("walks labels from subdomain to apex", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) =>
        url.includes("name=example.com")
          ? cfOk([{ id: "zone_cf", name: "example.com", status: "active" }])
          : cfOk([]),
      );
      global.fetch = fetchMock;

      const zone = await cloudflareDnsProvider.findZone({ apiToken: "t" }, "app.sub.example.com");

      expect(zone).toEqual({ id: "zone_cf", name: "example.com", status: "active" });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it("prefers the most specific zone when a subdomain is delegated on its own", async () => {
      // Both zones exist in the account. Exact-match the `name` param — a
      // substring check would let "app.sub.example.com" fall through to the apex.
      const zones: Record<string, { id: string; name: string; status: string }> = {
        "sub.example.com": { id: "zone_sub", name: "sub.example.com", status: "active" },
        "example.com": { id: "zone_apex", name: "example.com", status: "active" },
      };
      global.fetch = vi.fn().mockImplementation(async (url: string) => {
        const name = new URL(url).searchParams.get("name") ?? "";
        const hit = zones[name];
        return cfOk(hit ? [hit] : []);
      });

      const zone = await cloudflareDnsProvider.findZone({ apiToken: "t" }, "app.sub.example.com");
      expect(zone?.id).toBe("zone_sub");
    });

    it("returns null when nothing matches", async () => {
      global.fetch = vi.fn().mockResolvedValue(cfOk([]));
      expect(
        await cloudflareDnsProvider.findZone({ apiToken: "t" }, "nope.example.org"),
      ).toBeNull();
    });

    it("never probes a single-label host", async () => {
      const fetchMock = vi.fn().mockResolvedValue(cfOk([]));
      global.fetch = fetchMock;
      expect(await cloudflareDnsProvider.findZone({ apiToken: "t" }, "localhost")).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("bounds the walk so a long hostname can't fan out unbounded", async () => {
      const fetchMock = vi.fn().mockResolvedValue(cfOk([]));
      global.fetch = fetchMock;
      const deep = `${Array.from({ length: 18 }, (_, i) => `l${i}`).join(".")}.example.com`;
      await cloudflareDnsProvider.findZone({ apiToken: "t" }, deep);
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(8);
    });

    it("PROPAGATES a rate limit instead of reporting 'no zone'", async () => {
      // The whole point: a swallowed 429 tells the operator their token is wrong
      // when it is fine, and silently skips provisioning.
      global.fetch = vi.fn().mockResolvedValue(cfErr(429, "Rate limited"));
      await expect(
        cloudflareDnsProvider.findZone({ apiToken: "t" }, "app.example.com"),
      ).rejects.toBeInstanceOf(DnsApiError);
    });

    it("propagates an auth failure with isAuthFailure set", async () => {
      global.fetch = vi.fn().mockResolvedValue(cfErr(401, "Invalid API token"));
      const err = await cloudflareDnsProvider
        .findZone({ apiToken: "t" }, "app.example.com")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DnsApiError);
      expect((err as DnsApiError).isAuthFailure).toBe(true);
    });
  });

  describe("listRecords", () => {
    it("follows pagination past the first page", async () => {
      const fetchMock = vi.fn().mockImplementation(async (url: string) => {
        const page = new URL(url).searchParams.get("page");
        return cfOk([record({ id: `rec_p${page}` })], {
          total_pages: 3,
          page: Number(page),
        });
      });
      global.fetch = fetchMock;

      const records = await cloudflareDnsProvider.listRecords({ apiToken: "t" }, "zone_123");

      expect(records.map((r) => r.id)).toEqual(["rec_p1", "rec_p2", "rec_p3"]);
    });

    it("stops after one page when the provider reports no pagination", async () => {
      const fetchMock = vi.fn().mockResolvedValue(cfOk([record()]));
      global.fetch = fetchMock;
      await cloudflareDnsProvider.listRecords({ apiToken: "t" }, "zone_123");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("carries the provider comment through so ownership is checkable", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(cfOk([record({ comment: OPENSHIP_RECORD_COMMENT })]));
      const [r] = await cloudflareDnsProvider.listRecords({ apiToken: "t" }, "zone_123");
      expect(r?.comment).toBe(OPENSHIP_RECORD_COMMENT);
    });
  });

  describe("upsertRecord", () => {
    it("creates when nothing exists, stamping the ownership marker", async () => {
      let posted: Record<string, unknown> | null = null;
      global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted = JSON.parse(init.body as string) as Record<string, unknown>;
          return cfOk(record({ id: "rec_new", content: "192.0.2.1" }));
        }
        return cfOk([]);
      });

      const result = await cloudflareDnsProvider.upsertRecord({ apiToken: "t" }, "zone_123", {
        type: "A",
        name: "app.example.com",
        content: "192.0.2.1",
      });

      expect(result.id).toBe("rec_new");
      expect(posted).toMatchObject({ comment: OPENSHIP_RECORD_COMMENT, ttl: 1, proxied: false });
    });

    it("updates in place when one record already matches", async () => {
      let method = "";
      global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        method = init?.method ?? "GET";
        if (init?.method === "PUT") return cfOk(record({ content: "203.0.113.5" }));
        return cfOk([record({ content: "198.51.100.1" })]);
      });

      const result = await cloudflareDnsProvider.upsertRecord({ apiToken: "t" }, "zone_123", {
        type: "A",
        name: "app.example.com",
        content: "203.0.113.5",
      });

      expect(method).toBe("PUT");
      expect(result.content).toBe("203.0.113.5");
    });

    it("PRESERVES the operator's Cloudflare proxying instead of resetting it", async () => {
      let put: Record<string, unknown> | null = null;
      global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          put = JSON.parse(init.body as string) as Record<string, unknown>;
          return cfOk(record({ proxied: true, content: "203.0.113.5" }));
        }
        return cfOk([record({ proxied: true })]);
      });

      await cloudflareDnsProvider.upsertRecord({ apiToken: "t" }, "zone_123", {
        type: "A",
        name: "app.example.com",
        content: "203.0.113.5",
      });

      expect(put).toMatchObject({ proxied: true });
    });

    it("makes no write when the record already says exactly what we want", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(cfOk([record({ content: "192.0.2.1", ttl: 1, proxied: false })]));
      global.fetch = fetchMock;

      await cloudflareDnsProvider.upsertRecord({ apiToken: "t" }, "zone_123", {
        type: "A",
        name: "app.example.com",
        content: "192.0.2.1",
      });

      // The list call and nothing else — no PUT.
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("still writes when only the TTL differs from the effective desired value", async () => {
      // The old short-circuit ignored ttl whenever the caller passed none, so a
      // stale 86400 survived forever although our model says "automatic".
      let sawPut = false;
      global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          sawPut = true;
          return cfOk(record({ ttl: 1 }));
        }
        return cfOk([record({ ttl: 86400, content: "192.0.2.1" })]);
      });

      await cloudflareDnsProvider.upsertRecord({ apiToken: "t" }, "zone_123", {
        type: "A",
        name: "app.example.com",
        content: "192.0.2.1",
      });

      expect(sawPut).toBe(true);
    });

    // A single pre-existing record is the normal state of an apex being connected,
    // and it is the operator's. Repointing it is the feature; claiming it is not —
    // the marker is what releaseRecords deletes on, so stamping it here would make
    // "remove this domain" destroy a record Openship never created.
    it("REPOINTS a single unmarked operator record without claiming ownership", async () => {
      let put: Record<string, unknown> | null = null;
      global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          put = JSON.parse(init.body as string) as Record<string, unknown>;
          return cfOk(record({ comment: "prod origin", content: "203.0.113.5" }));
        }
        return cfOk([record({ comment: "prod origin" })]);
      });

      const result = await cloudflareDnsProvider.upsertRecord({ apiToken: "t" }, "zone_123", {
        type: "A",
        name: "app.example.com",
        content: "203.0.113.5",
      });

      expect(put).toMatchObject({ content: "203.0.113.5", comment: "prod origin" });
      expect(put?.comment).not.toBe(OPENSHIP_RECORD_COMMENT);
      expect(isOpenshipManaged(result)).toBe(false);
    });

    it("leaves a comment-less operator record unmarked when repointing it", async () => {
      let put: Record<string, unknown> = {};
      global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          put = JSON.parse(init.body as string) as Record<string, unknown>;
          return cfOk(record({ comment: null, content: "203.0.113.5" }));
        }
        return cfOk([record({ comment: null })]);
      });

      await cloudflareDnsProvider.upsertRecord({ apiToken: "t" }, "zone_123", {
        type: "A",
        name: "app.example.com",
        content: "203.0.113.5",
      });

      expect(put.content).toBe("203.0.113.5");
      expect("comment" in put).toBe(false);
    });

    it("REFUSES to rewrite a record set it does not own", async () => {
      // Two operator-owned A records = a round-robin. Rewriting one member leaves
      // the hostname answering with a mix of their origin and ours.
      global.fetch = vi.fn().mockResolvedValue(
        cfOk([
          record({ id: "rec_a", content: "203.0.113.10", comment: null }),
          record({ id: "rec_b", content: "203.0.113.11", comment: null }),
        ]),
      );

      await expect(
        cloudflareDnsProvider.upsertRecord({ apiToken: "t" }, "zone_123", {
          type: "A",
          name: "app.example.com",
          content: "192.0.2.1",
        }),
      ).rejects.toBeInstanceOf(DnsRecordConflictError);
    });

    it("updates OUR record when it sits alongside the operator's", async () => {
      let putUrl = "";
      global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          putUrl = url;
          return cfOk(record({ id: "rec_ours" }));
        }
        return cfOk([
          record({ id: "rec_theirs", comment: null, content: "203.0.113.10" }),
          record({ id: "rec_ours", comment: OPENSHIP_RECORD_COMMENT, content: "203.0.113.11" }),
        ]);
      });

      await cloudflareDnsProvider.upsertRecord({ apiToken: "t" }, "zone_123", {
        type: "A",
        name: "app.example.com",
        content: "192.0.2.1",
      });

      expect(putUrl).toContain("rec_ours");
    });

    it("normalizes a trailing dot and uppercase in the name", async () => {
      let posted: Record<string, unknown> | null = null;
      global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted = JSON.parse(init.body as string) as Record<string, unknown>;
          return cfOk(record());
        }
        return cfOk([]);
      });

      await cloudflareDnsProvider.upsertRecord({ apiToken: "t" }, "zone_123", {
        type: "A",
        name: "App.Example.COM.",
        content: "192.0.2.1",
      });

      expect(posted).toMatchObject({ name: "app.example.com" });
    });
  });

  describe("MX priority", () => {
    it("stamps the priority on create — an MX with no preference is invalid", async () => {
      let posted: Record<string, unknown> | null = null;
      global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          posted = JSON.parse(init.body as string) as Record<string, unknown>;
          return cfOk(record({ type: "MX", content: "mail.example.com", priority: 10 }));
        }
        return cfOk([]);
      });

      await cloudflareDnsProvider.upsertRecord({ apiToken: "t" }, "zone_123", {
        type: "MX",
        name: "example.com",
        content: "mail.example.com",
        priority: 10,
      });

      expect(posted).toMatchObject({ type: "MX", content: "mail.example.com", priority: 10 });
    });

    it("round-trips the priority back through listRecords", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(cfOk([record({ type: "MX", content: "mail.example.com", priority: 20 })]));
      const [r] = await cloudflareDnsProvider.listRecords({ apiToken: "t" }, "zone_123");
      expect(r?.priority).toBe(20);
    });

    it("rewrites when only the priority differs from the desired MX", async () => {
      let putBody: Record<string, unknown> | null = null;
      global.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PUT") {
          putBody = JSON.parse(init.body as string) as Record<string, unknown>;
          return cfOk(record({ type: "MX", content: "mail.example.com", priority: 10 }));
        }
        return cfOk([
          record({ type: "MX", content: "mail.example.com", priority: 50 }),
        ]);
      });

      await cloudflareDnsProvider.upsertRecord({ apiToken: "t" }, "zone_123", {
        type: "MX",
        name: "example.com",
        content: "mail.example.com",
        priority: 10,
      });

      expect(putBody).toMatchObject({ priority: 10 });
    });
  });

  describe("deleteRecord", () => {
    it("issues a DELETE for the record id", async () => {
      const fetchMock = vi.fn().mockResolvedValue(cfOk({ id: "rec_1" }));
      global.fetch = fetchMock;

      await cloudflareDnsProvider.deleteRecord({ apiToken: "t" }, "zone_123", "rec_1");

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe("DELETE");
      expect(url).toContain("/zones/zone_123/dns_records/rec_1");
    });

    it("treats an already-deleted record as success", async () => {
      global.fetch = vi.fn().mockResolvedValue(cfErr(404, "Record not found"));
      await expect(
        cloudflareDnsProvider.deleteRecord({ apiToken: "t" }, "zone_123", "rec_gone"),
      ).resolves.toBeUndefined();
    });

    it("still surfaces a real failure", async () => {
      global.fetch = vi.fn().mockResolvedValue(cfErr(403, "Forbidden"));
      await expect(
        cloudflareDnsProvider.deleteRecord({ apiToken: "t" }, "zone_123", "rec_1"),
      ).rejects.toBeInstanceOf(DnsApiError);
    });
  });

  describe("error mapping", () => {
    it("keeps the provider status separate from the response status", async () => {
      // A Cloudflare 404 must not become OUR 404 — the endpoint exists.
      global.fetch = vi.fn().mockResolvedValue(cfErr(404, "not found"));
      const err = await cloudflareDnsProvider
        .listRecords({ apiToken: "t" }, "zone_123")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DnsApiError);
      expect((err as DnsApiError).providerStatus).toBe(404);
      expect((err as DnsApiError).statusCode).toBe(502);
    });

    it("classifies a transport failure as transient", async () => {
      global.fetch = vi.fn().mockRejectedValue(new Error("socket hang up"));
      const err = await cloudflareDnsProvider
        .listRecords({ apiToken: "t" }, "zone_123")
        .catch((e: unknown) => e);
      expect((err as DnsApiError).isTransient).toBe(true);
    });

    // This runs inline on POST /domains, so an unbounded call outlives the
    // operator's own client deadline while it keeps writing records.
    it("bounds every call with an abort signal", async () => {
      const fetchMock = vi.fn().mockResolvedValue(cfOk([record()]));
      global.fetch = fetchMock;
      await cloudflareDnsProvider.listRecords({ apiToken: "t" }, "zone_123");
      const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(init?.signal?.aborted).toBe(false);
    });

    it("reports its own timeout as transient, not as 'no zone'", async () => {
      global.fetch = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("This operation was aborted"), {
          name: "AbortError",
        }));
      const err = await cloudflareDnsProvider
        .findZone({ apiToken: "t" }, "app.example.com")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DnsApiError);
      expect((err as DnsApiError).isTransient).toBe(true);
    });
  });
});
