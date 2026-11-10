import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  digitaloceanDnsProvider,
  ownerMarkerName,
  toRelativeName,
} from "@repo/platform/engine/modules/dns/providers/digitalocean.provider";
import {
  DnsApiError,
  DnsRecordConflictError,
  isOpenshipManaged,
} from "@repo/platform/engine/modules/dns/types";

/** Shape a v2 response the way the real API does. */
function doOk(body: unknown, status = 200) {
  return { ok: true, status, text: async () => JSON.stringify(body) } as Response;
}

function doErr(status: number, id: string, message: string) {
  return { ok: false, status, text: async () => JSON.stringify({ id, message }) } as Response;
}

const noContent = { ok: true, status: 204, text: async () => "" } as Response;

const rec = (over: Record<string, unknown> = {}) => ({
  id: 101,
  type: "A",
  name: "app",
  data: "198.51.100.1",
  ttl: 1800,
  priority: null,
  ...over,
});

const marker = (name: string, type: string, id: number, markerId = 900) => ({
  id: markerId,
  type: "TXT",
  name,
  data: `openship-owner;type=${type};id=${id}`,
  ttl: 1800,
  priority: null,
});

const list = (records: unknown[]) =>
  doOk({ domain_records: records, links: {}, meta: { total: records.length } });

/**
 * A tiny in-memory DigitalOcean zone behind `fetch`, so tests assert on the zone's
 * end state instead of the order of calls.
 */
function fakeZone(zone: string, initial: Array<Record<string, unknown>>) {
  const records = initial.map((r) => ({ ...r }));
  let nextId = 500;
  const failMarkerCreate = { value: false };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = init?.method ?? "GET";
    const base = `/v2/domains/${zone}/records`;
    if (u.pathname === base && method === "GET") {
      const name = u.searchParams.get("name");
      const type = u.searchParams.get("type");
      const relative = name ? (name === zone ? "@" : name.slice(0, -(zone.length + 1))) : null;
      return list(
        records.filter((r) => (!relative || r.name === relative) && (!type || r.type === type)),
      );
    }
    if (u.pathname === base && method === "POST") {
      const body = JSON.parse(String(init?.body));
      if (failMarkerCreate.value && String(body.name).startsWith("_openship-owner")) {
        return doErr(422, "unprocessable_entity", "Marker rejected");
      }
      const created = { id: nextId++, priority: null, ...body };
      records.push(created);
      return doOk({ domain_record: created }, 201);
    }
    const match = u.pathname.match(new RegExp(`^${base}/(\\d+)$`));
    if (match) {
      const index = records.findIndex((r) => String(r.id) === match[1]);
      if (index < 0)
        return doErr(404, "not_found", "The resource you requested could not be found.");
      if (method === "GET") return doOk({ domain_record: records[index] });
      if (method === "DELETE") {
        records.splice(index, 1);
        return noContent;
      }
      if (method === "PUT") {
        records[index] = { ...records[index], ...JSON.parse(String(init?.body)) };
        return doOk({ domain_record: records[index] });
      }
    }
    throw new Error(`unexpected ${method} ${url}`);
  });
  return { records, fetchMock, failMarkerCreate };
}

describe("digitaloceanDnsProvider", () => {
  const originalFetch = global.fetch;
  const creds = { apiToken: "dop_v1_test" };

  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe("preflight", () => {
    it("checks with a domain-scoped call, not /account, which needs account:read", async () => {
      const fetchMock = vi.fn().mockResolvedValue(list([]));
      global.fetch = fetchMock;
      const result = await digitaloceanDnsProvider.preflight(creds);
      expect(result.ok).toBe(true);
      expect(String(fetchMock.mock.calls[0]![0])).toContain("/v2/domains?per_page=1");
    });

    it("turns a 401 into scope guidance", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(doErr(401, "unauthorized", "Unable to authenticate you."));
      const result = await digitaloceanDnsProvider.preflight(creds);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toContain("domain read");
    });
  });

  describe("findZone", () => {
    it("walks to the most specific domain the account hosts", async () => {
      global.fetch = vi.fn(async (url: string) =>
        url.endsWith("/domains/example.com")
          ? doOk({ domain: { name: "example.com", ttl: 1800 } })
          : doErr(404, "not_found", "The resource you requested could not be found."),
      ) as unknown as typeof fetch;
      expect(await digitaloceanDnsProvider.findZone(creds, "app.sub.example.com")).toEqual({
        id: "example.com",
        name: "example.com",
        status: "active",
      });
    });

    it("throws on a rate limit instead of reporting the domain as unmanaged", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(doErr(429, "too_many_requests", "API rate limit exceeded."));
      const err = await digitaloceanDnsProvider
        .findZone(creds, "app.example.com")
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DnsApiError);
      expect((err as DnsApiError).isTransient).toBe(true);
    });

    it("never echoes the token in an error", async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(doErr(401, "unauthorized", `bad token ${creds.apiToken}`));
      const err = (await digitaloceanDnsProvider
        .findZone(creds, "app.example.com")
        .catch((e: unknown) => e)) as DnsApiError;
      expect(err.isAuthFailure).toBe(true);
      expect(err.message).not.toContain(creds.apiToken);
    });
  });

  describe("names", () => {
    it("maps the apex to @ and refuses a name outside the zone", () => {
      expect(toRelativeName("example.com", "example.com")).toBe("@");
      expect(toRelativeName("App.Example.com.", "example.com")).toBe("app");
      expect(() => toRelativeName("example.org", "example.com")).toThrow();
    });

    it("keeps a wildcard's marker name valid", () => {
      expect(ownerMarkerName("*.example.com")).toBe("_openship-owner._wildcard.example.com");
    });
  });

  describe("listRecords", () => {
    it("reports a record as ours only when a marker names its type and id", async () => {
      const { fetchMock } = fakeZone("example.com", [
        rec({ id: 101 }),
        rec({ id: 102, type: "TXT", data: "v=spf1 -all" }),
        marker("_openship-owner.app", "A", 101),
        // Names a record that was deleted and recreated by hand: not a claim on 102.
        marker("_openship-owner.app", "TXT", 7, 901),
      ]);
      global.fetch = fetchMock as unknown as typeof fetch;

      const records = await digitaloceanDnsProvider.listRecords(creds, "example.com", {
        name: "app.example.com",
      });
      expect(records.map((r) => [r.id, isOpenshipManaged(r)])).toEqual([
        ["101", true],
        ["102", false],
      ]);
    });

    it("hides markers from a zone-wide listing", async () => {
      const { fetchMock } = fakeZone("example.com", [
        rec(),
        marker("_openship-owner.app", "A", 101),
      ]);
      global.fetch = fetchMock as unknown as typeof fetch;
      const records = await digitaloceanDnsProvider.listRecords(creds, "example.com");
      expect(records.map((r) => r.name)).toEqual(["app.example.com"]);
    });

    it("reports CNAME targets fully qualified so a plan compares like with like", async () => {
      const { fetchMock } = fakeZone("example.com", [
        rec({ type: "CNAME", data: "edge.openship.io" }),
      ]);
      global.fetch = fetchMock as unknown as typeof fetch;
      const [record] = await digitaloceanDnsProvider.listRecords(creds, "example.com", {
        name: "app.example.com",
      });
      expect(record!.content).toBe(
        digitaloceanDnsProvider.formatContent!("CNAME", "edge.openship.io"),
      );
    });
  });

  describe("upsertRecord", () => {
    it("creates a record with a relative name and writes its ownership marker", async () => {
      const zone = fakeZone("example.com", []);
      global.fetch = zone.fetchMock as unknown as typeof fetch;

      const created = await digitaloceanDnsProvider.upsertRecord(creds, "example.com", {
        type: "CNAME",
        name: "www.example.com",
        content: "edge.openship.io",
      });

      expect(isOpenshipManaged(created)).toBe(true);
      expect(zone.records).toEqual([
        expect.objectContaining({ type: "CNAME", name: "www", data: "edge.openship.io." }),
        expect.objectContaining({
          type: "TXT",
          name: "_openship-owner.www",
          data: `openship-owner;type=CNAME;id=${created.id}`,
        }),
      ]);
    });

    it("takes the record back down when its marker cannot be written", async () => {
      const zone = fakeZone("example.com", []);
      zone.failMarkerCreate.value = true;
      global.fetch = zone.fetchMock as unknown as typeof fetch;

      await expect(
        digitaloceanDnsProvider.upsertRecord(creds, "example.com", {
          type: "A",
          name: "example.com",
          content: "198.51.100.7",
        }),
      ).rejects.toBeInstanceOf(DnsApiError);
      expect(zone.records).toEqual([]);
    });

    it("repoints an operator's record without claiming it", async () => {
      const zone = fakeZone("example.com", [rec({ id: 101, ttl: 3600 })]);
      global.fetch = zone.fetchMock as unknown as typeof fetch;

      const updated = await digitaloceanDnsProvider.upsertRecord(creds, "example.com", {
        type: "A",
        name: "app.example.com",
        content: "198.51.100.9",
      });

      expect(isOpenshipManaged(updated)).toBe(false);
      // The operator's TTL is theirs to keep.
      expect(zone.records).toEqual([
        expect.objectContaining({ id: 101, data: "198.51.100.9", ttl: 3600 }),
      ]);
    });

    it("refuses to rewrite a set of records it does not own", async () => {
      const zone = fakeZone("example.com", [
        rec({ id: 101 }),
        rec({ id: 102, data: "198.51.100.2" }),
      ]);
      global.fetch = zone.fetchMock as unknown as typeof fetch;

      await expect(
        digitaloceanDnsProvider.upsertRecord(creds, "example.com", {
          type: "A",
          name: "app.example.com",
          content: "198.51.100.9",
        }),
      ).rejects.toBeInstanceOf(DnsRecordConflictError);
    });
  });

  describe("deleteRecord", () => {
    it("removes the record and its marker, and leaves other markers alone", async () => {
      const zone = fakeZone("example.com", [
        rec({ id: 101 }),
        rec({ id: 102, type: "TXT", data: "token" }),
        marker("_openship-owner.app", "A", 101, 900),
        marker("_openship-owner.app", "TXT", 102, 901),
      ]);
      global.fetch = zone.fetchMock as unknown as typeof fetch;

      await digitaloceanDnsProvider.deleteRecord(creds, "example.com", "101");

      expect(zone.records.map((r) => r.id)).toEqual([102, 901]);
    });

    it("treats an already-deleted record as success", async () => {
      const zone = fakeZone("example.com", []);
      global.fetch = zone.fetchMock as unknown as typeof fetch;
      await expect(
        digitaloceanDnsProvider.deleteRecord(creds, "example.com", "404"),
      ).resolves.toBeUndefined();
    });
  });
});
