/**
 * Azure DevOps Service Hook verification — the security boundary. Azure signs
 * nothing, so the Basic password IS the credential: comparisons must be
 * timing-safe and must never pass with an empty candidate set.
 */

import { describe, expect, it } from "vitest";
import { verifyAzureBasicAuth } from "./azure.webhook-verify";

function basicHeader(user: string, password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}` };
}

describe("verifyAzureBasicAuth", () => {
  it("accepts the matching project secret", () => {
    expect(verifyAzureBasicAuth(basicHeader("openship", "secret-1"), ["secret-1"])).toEqual({
      valid: true,
    });
  });

  it("accepts when one of several candidate secrets matches", () => {
    expect(
      verifyAzureBasicAuth(basicHeader("openship", "b"), ["a", "b", "c"]),
    ).toEqual({ valid: true });
  });

  it("rejects a wrong password", () => {
    expect(verifyAzureBasicAuth(basicHeader("openship", "nope"), ["secret-1"]).valid).toBe(false);
  });

  it("rejects without an Authorization header", () => {
    expect(verifyAzureBasicAuth({}, ["secret-1"]).valid).toBe(false);
  });

  it("refuses closed when no secrets are configured", () => {
    expect(verifyAzureBasicAuth(basicHeader("openship", ""), []).valid).toBe(false);
  });

  it("rejects malformed Authorization headers", () => {
    expect(verifyAzureBasicAuth({ authorization: "Bearer abc" }, ["s"]).valid).toBe(false);
    expect(verifyAzureBasicAuth({ authorization: "Basic" }, ["s"]).valid).toBe(false);
  });

  it("treats everything after the first colon as the password", () => {
    // ADO sends "username:secret"; the username side never participates in the match.
    const header = { authorization: `Basic ${Buffer.from("user:secret").toString("base64")}` };
    expect(verifyAzureBasicAuth(header, ["secret"])).toEqual({ valid: true });
    expect(verifyAzureBasicAuth(header, ["user:secret"]).valid).toBe(false);
  });
});
