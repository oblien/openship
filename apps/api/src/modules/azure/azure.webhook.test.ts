import { describe, expect, it } from "vitest";
import { verifyAzureBasicAuth } from "./azure.webhook-verify";

function basic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

describe("verifyAzureBasicAuth", () => {
  it("accepts a matching Basic Auth password", () => {
    expect(
      verifyAzureBasicAuth({ authorization: basic("openship", "s3cret") }, ["s3cret"]),
    ).toEqual({ valid: true });
  });

  it("rejects a wrong password", () => {
    const result = verifyAzureBasicAuth({ authorization: basic("openship", "wrong") }, ["s3cret"]);
    expect(result.valid).toBe(false);
  });

  it("rejects a missing Authorization header", () => {
    const result = verifyAzureBasicAuth({}, ["s3cret"]);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Missing/);
  });

  it("rejects when no secrets are configured", () => {
    const result = verifyAzureBasicAuth({ authorization: basic("openship", "s3cret") }, []);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/No webhook secret/);
  });

  it("does not early-accept on the first differing byte of equal-length secrets", () => {
    // Both 8 chars — a naive `===` short-circuit would still be correct here,
    // but the implementation uses timingSafeEqual which requires equal length.
    const result = verifyAzureBasicAuth(
      { authorization: basic("openship", "abcd1234") },
      ["abcd9999"],
    );
    expect(result.valid).toBe(false);
  });
});
