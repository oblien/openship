import { beforeEach, describe, expect, it, vi } from "vitest";
import { getCredentialProvider } from "@repo/core";

const h = vi.hoisted(() => ({ safeFetch: vi.fn() }));
vi.mock("@repo/platform/engine/lib/safe-fetch", () => ({ safeFetch: h.safeFetch }));

import { digitaloceanList, digitaloceanRequest } from "@repo/platform/engine/lib/digitalocean-api";
import { verifyCredentialValues } from "@repo/platform/engine/modules/credentials/verify";

const token = "dop_v1_private";
const response = (body: unknown, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  json: vi.fn(async () => body),
});

beforeEach(() => vi.resetAllMocks());

describe("DigitalOcean API transport and connection verification", () => {
  it("uses the shared bounded transport without following credential-bearing redirects", async () => {
    const upstream = response({ message: `private details, ${token.slice(0, 12)}` }, 302);
    h.safeFetch.mockResolvedValue(upstream);
    await expect(digitaloceanRequest(token, "/domains")).rejects.toThrow("Request failed (302)");
    expect(upstream.json).not.toHaveBeenCalled();
    expect(h.safeFetch).toHaveBeenCalledExactlyOnceWith("https://api.digitalocean.com/v2/domains", {
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      timeoutMs: 15_000,
      maxBodyBytes: 1_000_000,
      maxRedirects: 0,
    });
  });

  it("rejects paths escaping the DNS API without sending a token", async () => {
    await expect(digitaloceanRequest(token, "/domains/../../account")).rejects.toThrow(
      "Invalid DNS API path",
    );
    expect(h.safeFetch).not.toHaveBeenCalled();
  });

  it("follows pagination even when a page is short, ignoring the upstream next URL", async () => {
    h.safeFetch
      .mockResolvedValueOnce(
        response({
          domains: [{ name: "a.example" }],
          links: { pages: { next: "http://127.0.0.1/steal" } },
        }),
      )
      .mockResolvedValueOnce(response({ domains: [{ name: "b.example" }], links: {} }));
    expect(await digitaloceanList(token, "/domains", "domains")).toEqual([
      { name: "a.example" },
      { name: "b.example" },
    ]);
    expect(h.safeFetch.mock.calls.map(([url]) => url)).toEqual([
      "https://api.digitalocean.com/v2/domains?per_page=200&page=1",
      "https://api.digitalocean.com/v2/domains?per_page=200&page=2",
    ]);
  });

  it("bounds pagination instead of returning a partial zone", async () => {
    h.safeFetch.mockResolvedValue(response({ domains: [], links: { pages: { next: "more" } } }));
    await expect(digitaloceanList(token, "/domains", "domains")).rejects.toThrow(
      "Too many results",
    );
    expect(h.safeFetch).toHaveBeenCalledTimes(50);
  });

  it("verifies a DNS connection without account scope or DNS writes", async () => {
    h.safeFetch.mockResolvedValue(response({ domains: [] }));
    expect(
      await verifyCredentialValues(getCredentialProvider("digitalocean")!, {
        selector: null,
        publicFields: {},
        secrets: { apiToken: token },
      }),
    ).toEqual({ ok: true });
    expect(h.safeFetch).toHaveBeenCalledOnce();
    expect(h.safeFetch.mock.calls[0]![0]).toBe(
      "https://api.digitalocean.com/v2/domains?per_page=1",
    );
  });

  it.each([401, 403, 429, 503])(
    "returns a sanitized failed connection verdict for HTTP %s",
    async (status) => {
      const upstream = response({ message: `private details, ${token}` }, status);
      h.safeFetch.mockResolvedValue(upstream);
      const result = await verifyCredentialValues(getCredentialProvider("digitalocean")!, {
        selector: null,
        publicFields: {},
        secrets: { apiToken: token },
      });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(token);
      expect(JSON.stringify(result)).not.toContain("private details");
      expect(upstream.json).not.toHaveBeenCalled();
    },
  );
});
