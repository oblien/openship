import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./lua/site_logger.lua", import.meta.url), "utf8");

describe("edge request telemetry privacy", () => {
  it("sanitizes the request URI before metrics or the raw request ring can consume it", () => {
    const helper = source.slice(
      source.indexOf("local function telemetry_uri"),
      source.indexOf("-- ── Enumerable sets", source.indexOf("local function telemetry_uri")),
    );

    expect(helper).toContain('u:match("^([^?#]*)")');
    expect(helper).toContain('return "/accept-invite/:token"');
    expect(helper).toContain('return "/api/auth/invitation-preview/:token"');
    expect(source).toContain('local uri     = telemetry_uri(ngx.var.request_uri or "/")');
    expect(source).not.toContain("local uri     = ngx.var.request_uri");

    const capture = source.indexOf('local uri     = telemetry_uri(ngx.var.request_uri or "/")');
    const ring = source.indexOf("-- ── 4. Raw request ring buffer");
    expect(capture).toBeGreaterThan(source.indexOf("local function telemetry_uri"));
    expect(ring).toBeGreaterThan(capture);
  });
});
