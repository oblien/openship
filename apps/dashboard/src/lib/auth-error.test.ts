import { describe, expect, it } from "vitest";
import { authErrorDetails } from "./auth-error";

describe("authErrorDetails", () => {
  it("explains an invalid MCP OAuth client", () => {
    expect(authErrorDetails("invalid_client", null)).toEqual({
      code: "invalid_client",
      message: "The connecting application is not registered or is no longer valid.",
    });
  });

  it("uses the authorization server description when available", () => {
    expect(authErrorDetails("invalid_request", "client_id is required").message).toBe(
      "client_id is required",
    );
  });

  it("bounds untrusted query values", () => {
    const details = authErrorDetails("x".repeat(200), "y".repeat(500));
    expect(details.code).toHaveLength(80);
    expect(details.message).toHaveLength(300);
  });

  it("does not resolve inherited object keys as error messages", () => {
    expect(authErrorDetails("constructor", null)).toEqual({
      code: "constructor",
      message: "The authorization request could not be completed. Start the connection again.",
    });
  });
});
