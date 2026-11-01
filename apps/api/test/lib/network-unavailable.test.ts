import { describe, expect, it } from "vitest";
import {
  isConnectionLoss,
  isNetworkUnavailableError,
} from "@repo/platform/engine/lib/remote-state";

describe("network unavailable classification", () => {
  it.each(["ENETUNREACH", "ENETDOWN", "ENONET"])(
    "recognizes %s through SSH/Docker wrappers and error causes",
    (code) => {
      const error = Object.assign(new Error("connect failed"), { code });
      expect(isNetworkUnavailableError(error)).toBe(true);
      expect(isNetworkUnavailableError(new Error("Could not reach Docker", { cause: error }))).toBe(
        true,
      );
      expect(
        isNetworkUnavailableError(
          `(HTTP code 502) unexpected - Cannot reach root@192.0.2.1:22 (connect ${code} 192.0.2.1:22 - Local (0.0.0.0:63263))`,
        ),
      ).toBe(true);
      expect(isConnectionLoss(error)).toBe(true);
    },
  );

  it.each([
    "connect ETIMEDOUT",
    "connect ECONNREFUSED",
    "connect EHOSTUNREACH",
    "getaddrinfo ENOTFOUND",
    "All configured authentication methods failed",
    "permission denied",
    "Exited with code 1",
  ])("does not infer a network-wide failure from %s", (message) => {
    expect(isNetworkUnavailableError(new Error(message))).toBe(false);
  });

  it("bounds cyclic error causes", () => {
    const error = new Error("unknown");
    error.cause = error;
    expect(isNetworkUnavailableError(error)).toBe(false);
    expect(isNetworkUnavailableError(null)).toBe(false);
  });
});
