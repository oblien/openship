import { describe, expect, it, vi } from "vitest";
import { providerFailureMessage } from "./provider-failure";

describe("provider failure messages", () => {
  it.each([
    [{ code: "ECONNREFUSED", statusCode: 503 }, "Operation failed (ECONNREFUSED, HTTP 503)"],
    [{ cause: { cause: { code: "ETIMEDOUT" } } }, "Operation failed (ETIMEDOUT)"],
    [{ $metadata: { httpStatusCode: 403 } }, "Operation failed (HTTP 403)"],
    [{ status: 429 }, "Operation failed (HTTP 429)"],
  ])("retains approved structured evidence: %j", (error, message) => {
    expect(providerFailureMessage(error, "Operation failed")).toBe(message);
  });

  it.each([
    "opaque-private-value", new Error("opaque-private-value"),
    { name: "opaque-private-value", code: "opaque-private-value", statusCode: "opaque-private-value" },
    { statusCode: 503.5 }, { statusCode: 600 }, { status: 99 },
  ])("uses the caller's summary for unknown data: %j", (error) => {
    expect(providerFailureMessage(error, "Operation failed")).toBe("Operation failed");
  });

  it("does not invoke provider getters or serialize provider objects", () => {
    const touched = vi.fn(() => { throw new Error("private getter"); });
    const error = Object.defineProperties({}, Object.fromEntries(
      ["message", "name", "code", "status", "statusCode", "$metadata", "cause", "toString", "toJSON"]
        .map((key) => [key, { get: touched }]),
    ));
    expect(providerFailureMessage(error, "Operation failed")).toBe("Operation failed");
    expect(touched).not.toHaveBeenCalled();
  });

  it("bounds cyclic causes and ignores evidence beyond the cause limit", () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(providerFailureMessage(error, "Operation failed")).toBe("Operation failed");
    expect(providerFailureMessage({ cause: { cause: { cause: { code: "ETIMEDOUT" } } } }, "Operation failed"))
      .toBe("Operation failed");
  });
});
