import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  contexts: {} as Record<string, { apiUrl?: string; dashboardUrl?: string; token?: string }>,
  added: [] as Array<{
    name: string;
    opts: { apiUrl?: string; dashboardUrl?: string; token?: string };
  }>,
  active: "default",
  interactive: false,
  target: "cloud",
  open: vi.fn(),
}));

vi.mock("node:process", async (original) => ({
  ...(await original<typeof import("node:process")>()),
  stdin: {
    get isTTY() {
      return h.interactive;
    },
  },
}));
vi.mock("@clack/prompts", () => ({
  isCancel: (value: unknown) => typeof value === "symbol",
  select: async () => h.target,
  text: async () => "https://ship.example.com/openship",
  password: async () => "opsh_pat_interactive_fixture",
}));
vi.mock("open", () => ({ default: h.open }));

vi.mock("../../src/lib/config", () => ({
  DEFAULT_CONTEXT: "default",
  getContext: (name?: string) => h.contexts[name ?? "default"] ?? {},
  getActiveContext: () => h.active,
  addContext: (name: string, opts: { apiUrl?: string; dashboardUrl?: string; token?: string }) => {
    h.added.push({ name, opts });
  },
  setActiveContext: vi.fn(),
  withCommandContext: (action: () => unknown) => action(),
}));
vi.mock("../../src/lib/caps", () => ({ fetchCaps: async () => ({}) }));
vi.mock("../../src/lib/local-connection", () => ({
  localConnectionEndpoints: () => ({
    apiUrl: "http://127.0.0.1:4000",
    dashboardUrl: "http://localhost:3001",
  }),
}));

import { loginCommand } from "../../src/commands/login";
import { CLOUD_API_URL, CLOUD_DASHBOARD_URL, LOCAL_DASHBOARD_URL } from "@repo/core";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";
import { setJsonMode } from "../../src/lib/output";

let fetchStub: FetchStub;
beforeEach(() => {
  h.contexts = {};
  h.added = [];
  h.active = "default";
  h.interactive = false;
  h.target = "cloud";
  h.open.mockClear();
  fetchStub = stubFetch(() => ({ status: 200, json: { data: [] } })); // /api/tokens validation passes
});
afterEach(() => {
  fetchStub.restore();
  setJsonMode(false);
});

describe("openship login endpoint preservation", () => {
  it("guides a fresh interactive login to Cloud and opens its token page", async () => {
    h.interactive = true;
    const result = await runCommand(loginCommand, []);
    expect(result.code).toBe(0);
    expect(h.open).toHaveBeenCalledWith(`${CLOUD_DASHBOARD_URL}/settings`);
    expect(fetchStub.calls[0].url).toBe(`${CLOUD_API_URL}/api/tokens`);
    expect(h.added.at(-1)).toMatchObject({ name: "cloud", opts: { apiUrl: CLOUD_API_URL } });
    expect(result.out + result.err).not.toContain("opsh_pat_interactive_fixture");
  });

  it("guides a remote login with one URL, preserves its proxy prefix, and names its context", async () => {
    h.interactive = true;
    h.target = "selfhosted";
    const result = await runCommand(loginCommand, []);
    expect(result.code).toBe(0);
    expect(h.open).toHaveBeenCalledWith("https://ship.example.com/openship/settings");
    expect(fetchStub.calls[0].url).toBe("https://ship.example.com/openship/api/tokens");
    expect(h.added.at(-1)).toMatchObject({
      name: "ship.example.com",
      opts: {
        apiUrl: "https://ship.example.com/openship",
        dashboardUrl: "https://ship.example.com/openship",
      },
    });
  });

  it("re-authenticates the active connection without switching back to default", async () => {
    h.active = "cloud";
    h.contexts.cloud = { apiUrl: CLOUD_API_URL, dashboardUrl: CLOUD_DASHBOARD_URL };
    const result = await runCommand(loginCommand, ["--token", "opsh_pat_renewed"]);
    expect(result.code).toBe(0);
    expect(h.added.at(-1)?.name).toBe("cloud");
    expect(fetchStub.calls[0].url).toBe(`${CLOUD_API_URL}/api/tokens`);
  });

  it("connects directly to Cloud and saves its organization under the cloud context", async () => {
    setJsonMode(true);
    const result = await runCommand(loginCommand, [
      "--cloud",
      "--token",
      "opsh_pat_cloud_fixture",
      "--organization",
      "org-cloud",
    ]);
    expect(result.code, result.err).toBe(0);
    expect(fetchStub.calls[0].url).toBe(`${CLOUD_API_URL}/api/tokens`);
    expect(h.added.at(-1)).toEqual({
      name: "cloud",
      opts: {
        apiUrl: CLOUD_API_URL,
        dashboardUrl: CLOUD_DASHBOARD_URL,
        token: "opsh_pat_cloud_fixture",
        organizationId: "org-cloud",
      },
    });
    expect(JSON.parse(result.out)).toMatchObject({ context: "cloud", organizationId: "org-cloud" });
    expect(result.out + result.err).not.toContain("opsh_pat_cloud_fixture");
  });

  it("returns secret-free JSON after non-interactive authentication", async () => {
    setJsonMode(true);
    const result = await runCommand(loginCommand, [
      "--token",
      "opsh_pat_json_secret",
      "--context",
      "ci",
    ]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({
      authenticated: true,
      context: "ci",
      scoped: false,
    });
    expect(result.out + result.err).not.toContain("opsh_pat_json_secret");
  });

  it("never prompts in JSON mode when no token was supplied", async () => {
    setJsonMode(true);
    const result = await runCommand(loginCommand, []);
    expect(result.code).toBe(1);
    expect(result.err).toContain("--token");
    expect(result.out).toBe("");
    expect(fetchStub.calls).toEqual([]);
    expect(h.added).toEqual([]);
  });
  it("re-login without --api-url keeps the context's saved endpoints (not localhost)", async () => {
    h.contexts.prod = {
      apiUrl: "https://api.prod.example.com",
      dashboardUrl: "https://dash.prod.example.com",
      token: "old",
    };

    const { code } = await runCommand(loginCommand, [
      "--token",
      "opsh_pat_test",
      "--context",
      "prod",
    ]);

    expect(code).toBe(0);
    // Validation hit the saved prod API, not localhost.
    expect(fetchStub.calls[0].url).toBe("https://api.prod.example.com/api/tokens");
    // Stored endpoints are the saved prod ones, with the fresh token.
    expect(h.added.at(-1)).toEqual({
      name: "prod",
      opts: {
        apiUrl: "https://api.prod.example.com",
        dashboardUrl: "https://dash.prod.example.com",
        token: "opsh_pat_test",
      },
    });
  });

  it("an explicit --api-url still overrides the saved endpoint", async () => {
    h.contexts.prod = {
      apiUrl: "https://api.prod.example.com",
      dashboardUrl: "https://dash.prod.example.com",
      token: "old",
    };

    await runCommand(loginCommand, [
      "--token",
      "opsh_pat_test",
      "--context",
      "prod",
      "--api-url",
      "https://api.staging.example.com",
    ]);

    expect(h.added.at(-1)?.opts.apiUrl).toBe("https://api.staging.example.com");
    expect(h.added.at(-1)?.opts.dashboardUrl).toBe("https://api.staging.example.com");
  });

  it("uses local defaults for a new context", async () => {
    await runCommand(loginCommand, ["--token", "opsh_pat_test", "--context", "new"]);

    expect(fetchStub.calls[0].url).toBe("http://127.0.0.1:4000/api/tokens");
    expect(h.added.at(-1)?.opts).toMatchObject({
      apiUrl: "http://127.0.0.1:4000",
      dashboardUrl: LOCAL_DASHBOARD_URL,
    });
  });

  it("keeps the saved API when only the dashboard is overridden", async () => {
    h.contexts.prod = {
      apiUrl: "https://api.prod.example.com",
      dashboardUrl: "https://dash.old.example.com",
    };
    await runCommand(loginCommand, [
      "--token",
      "opsh_pat_test",
      "--context",
      "prod",
      "--dashboard-url",
      "https://dash.new.example.com",
    ]);

    expect(fetchStub.calls[0].url).toBe("https://api.prod.example.com/api/tokens");
    expect(h.added.at(-1)?.opts.dashboardUrl).toBe("https://dash.new.example.com");
  });

  it("does not overwrite a context when the replacement token is rejected", async () => {
    h.contexts.prod = { apiUrl: "https://api.prod.example.com", token: "old" };
    fetchStub.restore();
    fetchStub = stubFetch(() => ({ status: 401, json: { error: "Unauthorized" } }));

    const { code } = await runCommand(loginCommand, [
      "--token",
      "opsh_pat_invalid",
      "--context",
      "prod",
    ]);

    expect(code).toBe(1);
    expect(h.added).toEqual([]);
  });
});
