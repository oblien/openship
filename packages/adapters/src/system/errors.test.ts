import { describe, expect, it } from "vitest";

import {
  isRemoteConnectionError,
  isRetryableRemoteConnectionError,
  isSshExecRequestError,
  SshExecRequestError,
} from "./errors";

describe("SSH exec-request error classification", () => {
  it("classifies the tagged error as remote without replaying whole callbacks", () => {
    const tagged = new SshExecRequestError(new Error("Unable to exec"));

    expect(isSshExecRequestError(tagged)).toBe(true);
    expect(isRetryableRemoteConnectionError(tagged)).toBe(false);
    expect(isRemoteConnectionError(tagged)).toBe(true);
  });

  it("does not classify ordinary command errors by message text", () => {
    expect(isRetryableRemoteConnectionError(new Error("Unable to exec"))).toBe(false);
    expect(
      isRetryableRemoteConnectionError(
        new Error("sudo: unable to execute helper: Permission denied"),
      ),
    ).toBe(false);
  });
});
