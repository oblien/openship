import { describe, expect, it } from "vitest";
import {
  normalizeEdgeResponse,
  normalizeResponsePath,
  EDGE_RESPONSE_MAX_BYTES,
} from "./edge-response";

describe("edge response input", () => {
  it("preserves literal content and normalizes headers without interpreting code", () => {
    const body = '<script>window.example = "$uri";</script>\nمرحبا';
    expect(normalizeEdgeResponse({ body, headers: { "X-Example": "$host" } })).toEqual({
      match: "exact",
      status: 200,
      contentType: "text/plain; charset=utf-8",
      body,
      headers: { "x-example": "$host" },
      methods: ["GET", "HEAD"],
    });
  });
  it("rejects header injection, duplicate case variants, and protocol-controlled headers", () => {
    for (const headers of [
      { "X-Test": "ok\r\nInjected: yes" },
      { "X-Test\n": "bad" },
      { "Content-Length": "500" },
      { "Transfer-Encoding": "chunked" },
      { "Content-Type": "text/html" },
      { "X-Test": "one", "x-test": "two" },
    ]) {
      expect(() => normalizeEdgeResponse({ headers })).toThrow();
    }
    expect(() => normalizeEdgeResponse({ contentType: "text/html\r\nInjected: true" })).toThrow();
    expect(() =>
      normalizeEdgeResponse({ contentType: `text/plain; note=${"ع".repeat(128)}` }),
    ).toThrow();
  });
  it("bounds UTF-8 bytes without truncating the response", () => {
    expect(normalizeEdgeResponse({ body: "a".repeat(EDGE_RESPONSE_MAX_BYTES) }).body).toHaveLength(
      EDGE_RESPONSE_MAX_BYTES,
    );
    expect(() => normalizeEdgeResponse({ body: "ع".repeat(EDGE_RESPONSE_MAX_BYTES) })).toThrow(
      /64 KiB/,
    );
  });
  it("enforces no-content statuses and valid final response codes", () => {
    for (const status of [204, 205, 304]) {
      expect(normalizeEdgeResponse({ status }).body).toBe("");
      expect(() => normalizeEdgeResponse({ status, body: "not empty" })).toThrow(/empty/);
    }
    for (const status of [101, 600, 200.5, "200"])
      expect(() => normalizeEdgeResponse({ status })).toThrow();
    expect(normalizeEdgeResponse({ status: 404, body: "Missing" }).status).toBe(404);
  });
  it("rejects misspelled methods instead of silently matching all traffic", () => {
    expect(() => normalizeEdgeResponse({ methods: ["GTE"] })).toThrow();
    expect(normalizeEdgeResponse({ methods: [] }).methods).toEqual([]);
  });
  it("canonicalizes encoded paths and protects platform endpoints", () => {
    expect(normalizeResponsePath("/r%C3%A9ponse")).toBe("/réponse");
    expect(normalizeResponsePath("/.well-known/assetlinks.json")).toBe(
      "/.well-known/assetlinks.json",
    );
    for (const path of [
      "x",
      "/x?y=1",
      "/x#y",
      "/x/../y",
      "//x",
      "/x\\y",
      "/%ZZ",
      "/_openship/auth",
      "/.well-known/acme-challenge/token",
    ]) {
      expect(() => normalizeResponsePath(path)).toThrow();
    }
  });
});
