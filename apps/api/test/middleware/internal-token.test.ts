/**
 * INTERNAL_TOKEN helper used by internalAuth and the empty-DB first-signup gate.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@/config", () => ({
  env: {
    INTERNAL_TOKEN: "test-internal-token-32bytes-ok!!",
    DEPLOY_MODE: "docker",
  },
}));

import { env } from "@/config";
import { hasValidInternalToken } from "@/middleware/internal-auth";

const e = env as unknown as { INTERNAL_TOKEN?: string };

function ctxWithToken(token: string | undefined) {
  return {
    req: {
      header: (name: string) =>
        name.toLowerCase() === "x-internal-token" ? token : undefined,
    },
  } as never;
}

beforeEach(() => {
  e.INTERNAL_TOKEN = "test-internal-token-32bytes-ok!!";
});

describe("hasValidInternalToken", () => {
  test("accepts an exact match", () => {
    expect(hasValidInternalToken(ctxWithToken("test-internal-token-32bytes-ok!!"))).toBe(true);
  });

  test("rejects missing header", () => {
    expect(hasValidInternalToken(ctxWithToken(undefined))).toBe(false);
  });

  test("rejects wrong token", () => {
    expect(hasValidInternalToken(ctxWithToken("wrong-token"))).toBe(false);
  });

  test("rejects length-mismatched token (timing-safe path)", () => {
    expect(hasValidInternalToken(ctxWithToken("short"))).toBe(false);
  });

  test("rejects when INTERNAL_TOKEN is unset", () => {
    e.INTERNAL_TOKEN = undefined;
    expect(hasValidInternalToken(ctxWithToken("test-internal-token-32bytes-ok!!"))).toBe(false);
  });
});
