import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// domain.ts calls the api-client directly (no local login guard); the config
// seam supplies the base URL + token, caps is stubbed self-hosted.
const h = vi.hoisted(() => ({ token: "tok" as string | null }));
vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => h.token,
}));
vi.mock("../../src/lib/caps", () => ({
  fetchCaps: async () => ({ selfHosted: true }),
  requireSelfHost: () => {},
}));

import { domainCommand } from "../../src/commands/domain";
import { setJsonMode } from "../../src/lib/output";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

const API = "http://api.test/api";

let fetchStub: FetchStub;
beforeEach(() => {
  h.token = "tok";
});
afterEach(() => {
  fetchStub?.restore();
  setJsonMode(false);
});

// ─── list ────────────────────────────────────────────────────────────────────

describe("openship domain list", () => {
  const DOMAINS = [
    { id: "d1", hostname: "app.example.com", domainType: "primary", isPrimary: true, verified: true, status: "active", sslStatus: "issued" },
    { id: "d2", hostname: "www.example.com", verified: false, status: "pending" },
  ];

  it("GETs /domains for the project and tabulates the rows", async () => {
    fetchStub = stubFetch(() => ({ json: { data: DOMAINS } }));
    const { out, code } = await runCommand(domainCommand, ["list", "-p", "prj 1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls).toHaveLength(1);
    expect(fetchStub.calls[0].method).toBe("GET");
    expect(fetchStub.calls[0].url).toBe(`${API}/domains?projectId=prj%201`); // project id is URL-encoded
    expect(out).toContain("app.example.com");
    expect(out).toContain("d2");
  });

  it("emits the raw rows as JSON in json mode", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => ({ json: { data: DOMAINS } }));
    const { out } = await runCommand(domainCommand, ["list", "-p", "prj1"]);
    expect(JSON.parse(out)).toEqual(DOMAINS);
  });

  it("renders an empty table when the project has no domains", async () => {
    fetchStub = stubFetch(() => ({ json: { data: [] } })); // the API always returns a data array, empty when none
    const { code } = await runCommand(domainCommand, ["list", "-p", "prj1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls).toHaveLength(1);
  });
});

// ─── add ─────────────────────────────────────────────────────────────────────

describe("openship domain add", () => {
  const ADDED = {
    data: { id: "d9", hostname: "app.example.com" },
    records: { mode: "selfhosted", records: [{ type: "CNAME", host: "app", value: "edge.example.net" }] },
  };

  it("POSTs the hostname to /domains and points the user at verify", async () => {
    fetchStub = stubFetch(() => ({ status: 201, json: ADDED }));
    const { err, code } = await runCommand(domainCommand, ["add", "app.example.com", "-p", "prj1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].url).toBe(`${API}/domains`);
    expect(fetchStub.calls[0].body).toEqual({ projectId: "prj1", hostname: "app.example.com", isPrimary: false });
    expect(err).toContain("openship domain verify d9"); // next-step hint names the new id
  });

  it("sets isPrimary when --primary is passed", async () => {
    fetchStub = stubFetch(() => ({ status: 201, json: ADDED }));
    await runCommand(domainCommand, ["add", "app.example.com", "-p", "prj1", "--primary"]);
    expect(fetchStub.calls[0].body).toMatchObject({ isPrimary: true });
  });

  it("emits the domain and its DNS records as JSON in json mode", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => ({ status: 201, json: ADDED }));
    const { out } = await runCommand(domainCommand, ["add", "app.example.com", "-p", "prj1"]);
    expect(JSON.parse(out)).toEqual({ domain: ADDED.data, records: ADDED.records });
  });
});

// ─── preview (no changes saved) ──────────────────────────────────────────────

describe("openship domain preview", () => {
  const PREVIEW = { data: { mode: "cloud", records: [{ type: "TXT", host: "_openship", value: "verify=abc" }] } };

  it("POSTs the hostname to /domains/preview and prints the record table", async () => {
    fetchStub = stubFetch(() => ({ json: PREVIEW }));
    const { out, err, code } = await runCommand(domainCommand, ["preview", "app.example.com"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].url).toBe(`${API}/domains/preview`);
    expect(fetchStub.calls[0].body).toEqual({ hostname: "app.example.com" });
    expect(err).toContain("DNS mode: cloud");
    expect(out).toContain("verify=abc");
  });

  it("emits the records result as JSON in json mode", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => ({ json: PREVIEW }));
    const { out } = await runCommand(domainCommand, ["preview", "app.example.com"]);
    expect(JSON.parse(out)).toEqual(PREVIEW.data);
  });
});

// ─── verify (apiRaw: 200 verified vs 422 not-propagated-yet) ──────────────────

describe("openship domain verify", () => {
  it("reports a verified domain and exits 0", async () => {
    fetchStub = stubFetch(() => ({ json: { verified: true, cnameVerified: true, txtVerified: true, message: "Domain verified" } }));
    const { err, code } = await runCommand(domainCommand, ["verify", "d1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].url).toBe(`${API}/domains/d1/verify`);
    expect(err).toContain("route/CNAME: ok");
    expect(err).toContain("TXT: ok");
  });

  it("treats a 422 (DNS not propagated) as not-verified and exits 1 without throwing", async () => {
    fetchStub = stubFetch(() => ({ status: 422, json: { verified: false, cnameVerified: false, txtVerified: true } }));
    const { err, code } = await runCommand(domainCommand, ["verify", "d1"]);
    expect(code).toBe(1); // the whole point of the command: unverified is a failure exit
    expect(fetchStub.calls).toHaveLength(1); // 422 is handled, not surfaced as an error before the request
    expect(err).toContain("route/CNAME: missing");
  });

  it("prints the raw result and does NOT exit 1 in json mode even when unverified", async () => {
    setJsonMode(true);
    const body = { verified: false, cnameVerified: false, txtVerified: false };
    fetchStub = stubFetch(() => ({ status: 422, json: body }));
    const { out, code } = await runCommand(domainCommand, ["verify", "d1"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual(body);
  });

  it("surfaces a non-422 error (e.g. 500) and exits 1", async () => {
    fetchStub = stubFetch(() => ({ status: 500, json: { error: "verifier crashed" } }));
    const { err, code } = await runCommand(domainCommand, ["verify", "d1"]);
    expect(code).toBe(1);
    expect(err).toContain("verifier crashed");
  });
});

// ─── primary ─────────────────────────────────────────────────────────────────

describe("openship domain primary", () => {
  const PRIMARY = { data: { id: "d1", hostname: "app.example.com", isPrimary: true } };

  it("POSTs /domains/:id/primary", async () => {
    fetchStub = stubFetch(() => ({ json: PRIMARY }));
    const { code } = await runCommand(domainCommand, ["primary", "d1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("POST");
    expect(fetchStub.calls[0].url).toBe(`${API}/domains/d1/primary`);
  });

  it("emits the updated domain as JSON in json mode", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => ({ json: PRIMARY }));
    const { out } = await runCommand(domainCommand, ["primary", "d1"]);
    expect(JSON.parse(out)).toEqual(PRIMARY.data);
  });
});

// ─── records ─────────────────────────────────────────────────────────────────

describe("openship domain records", () => {
  const RECORDS = { data: { mode: "selfhosted", records: [{ type: "A", host: "@", value: "203.0.113.5" }] } };

  it("GETs the existing DNS records for a domain", async () => {
    fetchStub = stubFetch(() => ({ json: RECORDS }));
    const { out, err, code } = await runCommand(domainCommand, ["records", "d1"]);
    expect(code).toBe(0);
    expect(fetchStub.calls[0].method).toBe("GET");
    expect(fetchStub.calls[0].url).toBe(`${API}/domains/d1/records`);
    expect(err).toContain("DNS mode: selfhosted");
    expect(out).toContain("203.0.113.5");
  });

  it("emits the records result as JSON in json mode", async () => {
    setJsonMode(true);
    fetchStub = stubFetch(() => ({ json: RECORDS }));
    const { out } = await runCommand(domainCommand, ["records", "d1"]);
    expect(JSON.parse(out)).toEqual(RECORDS.data);
  });
});
