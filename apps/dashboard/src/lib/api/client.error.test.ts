/**
 * What the operator reads when a request fails.
 *
 * `getApiErrorMessage` is the one formatter behind essentially every error toast
 * in the dashboard, so a throw it doesn't recognise becomes user-facing copy
 * verbatim. That is how the add-server "Test connection" button came to report
 * `signal is aborted without reason`: `doFetch` aborts its own request with no
 * reason, and the browser's internal wording fell straight through the generic
 * `err instanceof Error` arm.
 */

import { describe, expect, it } from "vitest";

import {
  ApiError,
  getApiErrorMessage,
  isAbortError,
  REQUEST_TIMEOUT_MESSAGE,
} from "./client";

/** What `AbortController.abort()` (no reason) actually throws in a browser. */
function browserAbort(): unknown {
  return new DOMException("signal is aborted without reason", "AbortError");
}

/** undici/Node throw a plain Error named AbortError — same event, different class. */
function undiciAbort(): unknown {
  const err = new Error("This operation was aborted");
  err.name = "AbortError";
  return err;
}

describe("isAbortError", () => {
  it("recognises the browser DOMException", () => {
    expect(isAbortError(browserAbort())).toBe(true);
  });

  it("recognises a plain Error named AbortError", () => {
    // Matched on `name`, not `instanceof DOMException`: SSR and tests run on
    // undici, where the narrower check silently reads an abort as a real failure.
    expect(isAbortError(undiciAbort())).toBe(true);
  });

  it("does not claim ordinary failures", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError(new TypeError("Failed to fetch"))).toBe(false);
    expect(isAbortError(new ApiError(502, "Bad Gateway", { message: "nope" }))).toBe(false);
    expect(isAbortError("aborted")).toBe(false);
  });
});

describe("getApiErrorMessage", () => {
  it("never surfaces the browser's own abort wording", () => {
    for (const abort of [browserAbort(), undiciAbort()]) {
      const message = getApiErrorMessage(abort, "Connection test failed");
      expect(message).toBe(REQUEST_TIMEOUT_MESSAGE);
      expect(message).not.toContain("signal is aborted");
      expect(message).not.toContain("operation was aborted");
    }
  });

  it("prefers the API's own message over the caller's fallback", () => {
    // The whole point of raising the client timeout above the server's budget:
    // a 502 carrying a classified reason is worth strictly more than a timeout.
    const err = new ApiError(502, "Bad Gateway", { message: "Host is not reachable" });
    expect(getApiErrorMessage(err, "Connection test failed")).toBe("Host is not reachable");
  });

  it("explains an HTML gateway failure without showing the page or an empty status label", () => {
    const err = new ApiError(
      502,
      "",
      "<!DOCTYPE html><html>Cloudflare private diagnostic page</html>",
    );
    const message = getApiErrorMessage(err, "Failed to start deployment");
    expect(message).toContain("Failed to start deployment");
    expect(message).toContain("upstream service");
    expect(message).toContain("502");
    expect(message).toMatch(/try again/i);
    expect(message).not.toContain("<html>");
    expect(message).not.toContain("private diagnostic");
    expect(message).not.toBe("API 502: ");
  });

  it("uses the public detail from a structured gateway problem response", () => {
    const err = new ApiError(502, "", {
      type: "https://errors.example.com/origin-unreachable",
      title: "Bad Gateway",
      status: 502,
      detail: "The origin server could not complete this request. Try again shortly.",
    });
    expect(getApiErrorMessage(err, "Failed to start deployment")).toBe(
      "The origin server could not complete this request. Try again shortly.",
    );
  });

  it("surfaces the first field error of a schema-validation 400", () => {
    const err = new ApiError(400, "Bad Request", {
      success: false,
      errors: [{ path: "sshHost", message: "is required" }],
    });
    expect(getApiErrorMessage(err, "fallback")).toBe("sshHost is required");
  });

  it("falls back for a bodyless failure and for a non-Error throw", () => {
    expect(getApiErrorMessage(new ApiError(500, "Internal Server Error", undefined), "fallback")).toBe(
      "API 500: Internal Server Error",
    );
    expect(getApiErrorMessage({ weird: true }, "fallback")).toBe("fallback");
  });
});
