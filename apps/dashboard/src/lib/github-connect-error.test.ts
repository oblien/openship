import { describe, expect, it, vi } from "vitest";

import {
  consumeGitHubConnectError,
  GITHUB_CONNECT_ERROR_KEY,
  githubConnectErrorMessage,
  storeGitHubConnectError,
} from "./github-connect-error";

describe("githubConnectErrorMessage", () => {
  it("maps known OAuth error codes to actionable copy", () => {
    expect(githubConnectErrorMessage("account_already_linked_to_different_user")).toContain(
      "already linked to a different Openship user",
    );
  });

  it("labels an unknown OAuth error code", () => {
    expect(githubConnectErrorMessage("provider_callback_failed")).toBe(
      "Couldn't connect GitHub (provider_callback_failed).",
    );
  });

  it("preserves a server-provided installation error message", () => {
    expect(githubConnectErrorMessage("This install link expired. Start again.")).toBe(
      "This install link expired. Start again.",
    );
  });
});

describe("GitHub connect error storage", () => {
  it("shares a callback error once and clears it after consumption", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => values.set(key, value)),
      removeItem: vi.fn((key: string) => values.delete(key)),
    };

    storeGitHubConnectError("claim failed", storage);

    expect(values.get(GITHUB_CONNECT_ERROR_KEY)).toBe("claim failed");
    expect(consumeGitHubConnectError(storage)).toBe("claim failed");
    expect(consumeGitHubConnectError(storage)).toBeNull();
  });

  it("fails closed when browser storage is unavailable", () => {
    expect(() => storeGitHubConnectError("claim failed", null)).not.toThrow();
    expect(consumeGitHubConnectError(null)).toBeNull();
  });
});
