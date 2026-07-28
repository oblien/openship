import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * getAuthMode() — one direct source, no inference.
 *
 * authMode decides whether a request needs a login at all, and it used to be
 * *inferred*: a mutable `instanceSettings.authMode` row on top of a
 * `DEPLOY_MODE === "desktop" ? "none" : "local"` guess on top of a catch-all
 * default that failed OPEN (a DB error handed out zero-auth on desktop). A single
 * stale "cloud" row — written by self-app.controller when a box with no local admin
 * connects Openship Cloud — was enough to send the loopback-only desktop app to a
 * remote sign-in screen with no way back.
 *
 * The contract these tests pin:
 *   - OPENSHIP_AUTH_MODE, when set, is the ONLY source. It outranks any stored row,
 *     and the DB is not read at all.
 *   - Undeclared, the stored value is the source — so self-hosted keeps its runtime
 *     upgrades (bootstrap-admin, upgrade-to-auth) with no restart.
 *   - Undeclared and unreadable → "local". FAIL CLOSED. "none" must never be the
 *     consequence of a failed query.
 *   - Nothing is inferred from DEPLOY_MODE.
 */

const settings: { authMode?: string | null } = {};
let getCalls = 0;
let getThrows = false;

vi.mock("@repo/db", () => ({
  repos: {
    instanceSettings: {
      get: async () => {
        getCalls++;
        if (getThrows) throw new Error("settings table unavailable");
        return settings;
      },
    },
  },
}));

const envMock: Record<string, unknown> = {};
vi.mock("../../src/config/env", () => ({ env: envMock }));

async function resolve(): Promise<string> {
  const mod = await import("../../src/lib/auth-mode");
  mod.clearAuthModeCache();
  return mod.getAuthMode();
}

beforeEach(() => {
  for (const k of Object.keys(envMock)) delete envMock[k];
  delete settings.authMode;
  getCalls = 0;
  getThrows = false;
});

afterEach(async () => {
  const { clearAuthModeCache } = await import("../../src/lib/auth-mode");
  clearAuthModeCache();
});

describe("getAuthMode() — declared (OPENSHIP_AUTH_MODE)", () => {
  it.each(["none", "local", "cloud"])("returns the declared mode (%s)", async (mode) => {
    envMock.OPENSHIP_AUTH_MODE = mode;
    expect(await resolve()).toBe(mode);
  });

  it("outranks a contradicting stored row", async () => {
    // The exact desktop bug: a stale "cloud" row must not win.
    envMock.OPENSHIP_AUTH_MODE = "none";
    settings.authMode = "cloud";
    expect(await resolve()).toBe("none");
  });

  it("never reads the DB when declared", async () => {
    envMock.OPENSHIP_AUTH_MODE = "none";
    settings.authMode = "cloud";
    await resolve();
    expect(getCalls).toBe(0);
  });

  it("is unaffected by an unreadable settings table", async () => {
    envMock.OPENSHIP_AUTH_MODE = "none";
    getThrows = true;
    expect(await resolve()).toBe("none");
  });

  it("ignores DEPLOY_MODE entirely", async () => {
    // A declared "local" on desktop stands: someone putting a password on a shared
    // machine must not be silently downgraded to zero-auth.
    envMock.DEPLOY_MODE = "desktop";
    envMock.OPENSHIP_AUTH_MODE = "local";
    expect(await resolve()).toBe("local");
  });
});

describe("getAuthMode() — undeclared (DB-backed)", () => {
  it.each(["none", "local", "cloud"])("uses the stored mode (%s)", async (mode) => {
    settings.authMode = mode;
    expect(await resolve()).toBe(mode);
  });

  it("fails CLOSED to local when the settings lookup throws", async () => {
    getThrows = true;
    expect(await resolve()).toBe("local");
  });

  it("fails CLOSED to local on desktop too — nothing is inferred from DEPLOY_MODE", async () => {
    // The old code returned "none" here: a DB error granted zero-auth.
    envMock.DEPLOY_MODE = "desktop";
    getThrows = true;
    expect(await resolve()).toBe("local");
  });

  it("defaults to local when no mode has been written", async () => {
    expect(await resolve()).toBe("local");
  });

  it("rejects a garbage stored value rather than trusting it", async () => {
    settings.authMode = "definitely-not-a-mode";
    expect(await resolve()).toBe("local");
  });

  it("caches so authMiddleware doesn't query per request", async () => {
    settings.authMode = "local";
    const { clearAuthModeCache, getAuthMode } = await import("../../src/lib/auth-mode");
    clearAuthModeCache();
    await getAuthMode();
    await getAuthMode();
    expect(getCalls).toBe(1);
  });
});

describe("pin helpers", () => {
  it("reports the declared mode", async () => {
    envMock.OPENSHIP_AUTH_MODE = "none";
    const { isAuthModePinned, pinnedAuthMode } = await import("../../src/lib/auth-mode");
    expect(isAuthModePinned()).toBe(true);
    expect(pinnedAuthMode()).toBe("none");
  });

  it("reports unpinned when nothing was declared", async () => {
    const { isAuthModePinned, pinnedAuthMode } = await import("../../src/lib/auth-mode");
    expect(isAuthModePinned()).toBe(false);
    expect(pinnedAuthMode()).toBeNull();
  });
});
