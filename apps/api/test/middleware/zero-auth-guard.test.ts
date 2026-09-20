/**
 * Guard for the unauth instance-takeover fix (CWE-306). zeroAuthAllowed is the
 * single gate both authMiddleware and the public /upgrade-to-auth route use;
 * these lock in that a fresh network-reachable install can NEVER bootstrap an
 * admin, and only a loopback desktop (or explicit opt-in) may.
 */

import { describe, test, expect, vi, beforeEach } from "vitest";

vi.mock("@repo/platform/engine/config/env", () => ({
  env: {
    DEPLOY_MODE: "docker",
    OPENSHIP_ALLOW_ZERO_AUTH: false,
    OPENSHIP_REQUIRE_AUTH: false,
    OPENSHIP_PUBLIC_URL: undefined as string | undefined,
  },
}));
vi.mock("@repo/platform/engine/lib/auth-mode", () => ({ getAuthMode: vi.fn(async () => "none") }));
vi.mock("@/middleware/loopback-peer", () => ({
  isLoopbackRequest: vi.fn(() => true),
  peerAddress: () => "203.0.113.9",
}));

import { env } from "@repo/platform/engine/config/env";
import { getAuthMode } from "@repo/platform/engine/lib/auth-mode";
import { isLoopbackRequest } from "@/middleware/loopback-peer";
import { zeroAuthAllowed } from "@/middleware/zero-auth-guard";

const ctx = {} as never;
const e = env as unknown as Record<string, unknown>;

beforeEach(() => {
  e.DEPLOY_MODE = "docker";
  e.OPENSHIP_ALLOW_ZERO_AUTH = false;
  e.OPENSHIP_REQUIRE_AUTH = false;
  e.OPENSHIP_PUBLIC_URL = undefined;
  (getAuthMode as ReturnType<typeof vi.fn>).mockResolvedValue("none");
  (isLoopbackRequest as ReturnType<typeof vi.fn>).mockReturnValue(true);
});

describe("zeroAuthAllowed", () => {
  test("fresh self-hosted (authMode resolves to local) → refused", async () => {
    (getAuthMode as ReturnType<typeof vi.fn>).mockResolvedValue("local");
    expect((await zeroAuthAllowed(ctx)).ok).toBe(false);
  });

  test("mode=none + docker + no opt-in → refused even from loopback", async () => {
    expect((await zeroAuthAllowed(ctx)).ok).toBe(false);
  });

  test("mode=none + opt-in but NON-loopback peer → refused", async () => {
    e.OPENSHIP_ALLOW_ZERO_AUTH = true;
    (isLoopbackRequest as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect((await zeroAuthAllowed(ctx)).ok).toBe(false);
  });

  test("mode=none + publicly-served (OPENSHIP_PUBLIC_URL) → refused", async () => {
    e.DEPLOY_MODE = "desktop";
    e.OPENSHIP_PUBLIC_URL = "https://openship.example";
    expect((await zeroAuthAllowed(ctx)).ok).toBe(false);
  });

  test("mode=none + desktop + loopback → allowed (the only happy path)", async () => {
    e.DEPLOY_MODE = "desktop";
    expect((await zeroAuthAllowed(ctx)).ok).toBe(true);
  });

  test("mode=none + docker + explicit opt-in + loopback → allowed", async () => {
    e.OPENSHIP_ALLOW_ZERO_AUTH = true;
    expect((await zeroAuthAllowed(ctx)).ok).toBe(true);
  });
});
