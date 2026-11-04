import { describe, expect, it } from "vitest";
import { readTokenAudience } from "../../src/lib/mcp-token";

// Audience parsing is not authentication; auth-mcp-provider.test.ts exercises
// real provider signatures, live grants, expiry and revocation.
const token = (aud: unknown) =>
  `header.${Buffer.from(JSON.stringify({ aud })).toString("base64url")}.signature`;

describe("readTokenAudience", () => {
  it("reads string and single-element JWT audiences", () => {
    const resource = "https://ship.example.net/api/mcp";
    expect(readTokenAudience(token(resource))).toBe(resource);
    expect(readTokenAudience(token([resource]))).toBe(resource);
  });
  it.each(["opaque-token", "opsh_pat_abc.def", "x.invalid-base64.z", token(undefined), token(123)])(
    "does not infer an audience from %s",
    (value) => expect(readTokenAudience(value)).toBeNull(),
  );
});
