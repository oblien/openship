import { describe, expect, it } from "vitest";
import {
  isSignedByThisInstance,
  readTokenAudience,
  signMcpAccessToken,
} from "../../src/lib/mcp-token";

/**
 * Audience-bound access tokens. The resource server's half of RFC 8707: a token
 * minted for one resource must be recognizable as such. Legacy opaque tokens
 * (everything issued before this existed) must stay usable, which is why
 * "no audience" reads as null rather than as a failure.
 */

const claims = {
  iss: "https://ship.example.net",
  sub: "user_1",
  aud: "https://ship.example.net/api/mcp",
  iat: 1_700_000_000,
  exp: 1_700_003_600,
  jti: "opaqueTokenValue",
  client_id: "client_1",
  scope: "openid profile",
};

describe("signMcpAccessToken", () => {
  it("produces a JWT whose payload carries the requested audience and issuer", () => {
    const token = signMcpAccessToken(claims);
    expect(token.split(".")).toHaveLength(3);

    const payload = JSON.parse(
      Buffer.from(token.split(".")[1] as string, "base64url").toString("utf8"),
    );
    expect(payload.aud).toBe("https://ship.example.net/api/mcp");
    expect(payload.iss).toBe("https://ship.example.net");
    expect(payload.sub).toBe("user_1");
    expect(payload.jti).toBe("opaqueTokenValue");
  });

  it("declares the access-token JWT type in its header", () => {
    const token = signMcpAccessToken(claims);
    const header = JSON.parse(
      Buffer.from(token.split(".")[0] as string, "base64url").toString("utf8"),
    );
    expect(header).toEqual({ alg: "HS256", typ: "at+jwt" });
  });
});

describe("isSignedByThisInstance", () => {
  it("accepts a token we minted and rejects a tampered payload", () => {
    const token = signMcpAccessToken(claims);
    expect(isSignedByThisInstance(token)).toBe(true);

    const [header, , signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ ...claims, aud: "https://evil.example.com/api/mcp" }),
    ).toString("base64url");
    expect(isSignedByThisInstance(`${header}.${forged}.${signature}`)).toBe(false);
  });

  it("rejects an opaque token outright", () => {
    expect(isSignedByThisInstance("YFXtCJVWJnfLoBqcJdQGtiJmwEbJDKcM")).toBe(false);
  });
});

describe("readTokenAudience", () => {
  it("reads the audience off a token we minted", () => {
    expect(readTokenAudience(signMcpAccessToken(claims))).toBe(
      "https://ship.example.net/api/mcp",
    );
  });

  it("reports NO audience for an opaque legacy token, so it stays unconstrained", () => {
    expect(readTokenAudience("YFXtCJVWJnfLoBqcJdQGtiJmwEbJDKcM")).toBeNull();
    expect(readTokenAudience("opsh_pat_abc.def")).toBeNull();
  });

  it("reports no audience for a JWT-shaped value with an unusable aud", () => {
    const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: "x" })).toString("base64url");
    expect(readTokenAudience(`${header}.${payload}.sig`)).toBeNull();
  });
});
