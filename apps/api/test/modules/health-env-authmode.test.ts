import { afterEach, describe, expect, it, vi } from "vitest";

// GET /health/env is what the dashboard reads to decide which login flow to
// render ("none" → zero-auth, "local" → Better Auth login). The non-desktop
// branch used to hardcode "local" while still querying instanceSettings for its
// siblings, so an operator who completed the deliberate zero-auth opt-in
// (OPENSHIP_ALLOW_ZERO_AUTH + `confirm: "I-understand-no-auth"`, see
// modules/system/setup.controller.ts) still got a login screen — even though
// authMiddleware, via lib/auth-mode.ts, had already resolved "none".
//
// DEPLOY_MODE defaults to "docker" under vitest (see vitest.config.ts), so
// these exercise the non-desktop path.

const settings: {
  authMode?: string | null;
  teamMode?: string | null;
  migrationTargetUrl?: string | null;
  migrationInProgress?: boolean | null;
} = {};

let getThrows = false;

vi.mock("@repo/db", () => ({
  repos: {
    instanceSettings: {
      get: async () => {
        if (getThrows) throw new Error("settings table unavailable mid-migration");
        return settings;
      },
    },
  },
}));

async function getEnv() {
  const { healthRoutes } = await import("../../src/modules/health/health.routes");
  const res = await healthRoutes.request("/env");
  return { res, body: (await res.json()) as Record<string, unknown> };
}

afterEach(() => {
  getThrows = false;
  delete settings.authMode;
  delete settings.teamMode;
});

describe("GET /health/env authMode", () => {
  it("reports the persisted zero-auth mode instead of hardcoding local", async () => {
    settings.authMode = "none";

    const { res, body } = await getEnv();
    expect(res.status).toBe(200);
    expect(body.deployMode).not.toBe("desktop");
    expect(body.authMode).toBe("none");
  });

  it("reports a persisted cloud mode", async () => {
    settings.authMode = "cloud";
    expect((await getEnv()).body.authMode).toBe("cloud");
  });

  it("defaults to local when no authMode has been written", async () => {
    // Matches getAuthMode()'s non-desktop fallback: require login on a fresh
    // self-hosted install.
    expect((await getEnv()).body.authMode).toBe("local");
  });

  it("falls back to local when the settings lookup fails", async () => {
    // The settings table may be unavailable mid-migration; failing closed to
    // "login required" is the safe default.
    getThrows = true;
    expect((await getEnv()).body.authMode).toBe("local");
  });

  it("still reports the other instanceSettings fields", async () => {
    settings.authMode = "none";
    settings.teamMode = "multi_user";

    const { body } = await getEnv();
    expect(body.teamMode).toBe("multi_user");
    expect(body.migrationInProgress).toBe(false);
    expect(body.migrationTargetUrl).toBeNull();
  });
});
