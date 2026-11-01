import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Isolate the client from on-disk config: fixed base URL + token.
vi.mock("../../src/lib/config", () => ({
  getApiUrl: () => "http://api.test",
  getToken: () => "tok-123",
}));

import { getRemoteClient, ApiError } from "../../src/lib/ship-client";
import { stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
afterEach(() => fetchStub?.restore());

describe("getApiUrl", () => {
  it("appends the /api prefix to the configured base", () => {
    expect(getRemoteClient().http.apiUrl).toBe("http://api.test/api");
  });
});

describe("apiRequest", () => {
  beforeEach(() => {
    fetchStub = stubFetch(() => ({ json: { ok: true } }));
  });

  it("targets /api and attaches the bearer token + JSON content type", async () => {
    await getRemoteClient().http.request("/servers");
    const req = fetchStub.calls[0];
    expect(req.url).toBe("http://api.test/api/servers");
    expect(req.headers.authorization).toBe("Bearer tok-123");
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("returns the parsed JSON body on 2xx", async () => {
    fetchStub.restore();
    fetchStub = stubFetch(() => ({ json: { id: "s1" } }));
    expect(await getRemoteClient().http.request("/servers/s1")).toEqual({ id: "s1" });
  });

  it("returns undefined on 204 without parsing", async () => {
    fetchStub.restore();
    fetchStub = stubFetch(() => ({ status: 204 }));
    expect(await getRemoteClient().http.request("/servers/s1", { method: "DELETE" })).toBeUndefined();
  });

  it("throws ApiError carrying status + the {error} message on non-2xx", async () => {
    fetchStub.restore();
    fetchStub = stubFetch(() => ({ status: 404, json: { error: "no such server" } }));
    await expect(getRemoteClient().http.request("/servers/missing")).rejects.toMatchObject({
      name: "ApiError",
      status: 404,
      message: "no such server",
    });
  });

  it("falls back to a generic message when the error body has none", async () => {
    fetchStub.restore();
    fetchStub = stubFetch(() => ({ status: 500, json: {} }));
    await expect(getRemoteClient().http.request("/x")).rejects.toBeInstanceOf(ApiError);
    await expect(getRemoteClient().http.request("/x")).rejects.toThrow(/500/);
  });
});

describe("paginate", () => {
  it("walks pages until a short/empty page and yields every item", async () => {
    const pages: Record<number, unknown[]> = {
      1: [{ n: 1 }, { n: 2 }],
      2: [{ n: 3 }],
    };
    fetchStub = stubFetch((req) => {
      const page = Number(new URL(req.url).searchParams.get("page") ?? "1");
      return { json: { data: pages[page] ?? [], total: 3 } };
    });

    const seen: number[] = [];
    for await (const item of getRemoteClient().http.paginate<{ n: number }>("/things", { perPage: 2 })) {
      seen.push(item.n);
    }
    expect(seen).toEqual([1, 2, 3]);
  });

  it("stops when the running count reaches the reported total", async () => {
    fetchStub = stubFetch(() => ({ json: { data: [{ n: 1 }, { n: 2 }], total: 2 } }));
    const seen: number[] = [];
    for await (const item of getRemoteClient().http.paginate<{ n: number }>("/things", { perPage: 2 })) {
      seen.push(item.n);
    }
    expect(seen).toEqual([1, 2]);
    expect(fetchStub.calls).toHaveLength(1); // total reached, no second page fetched
  });
});
