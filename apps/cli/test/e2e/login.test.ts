import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  contexts: {} as Record<string, { apiUrl?: string; dashboardUrl?: string; token?: string }>,
  added: [] as Array<{ name: string; opts: { apiUrl?: string; dashboardUrl?: string; token?: string } }>,
}));

vi.mock("../../src/lib/config", () => ({
  DEFAULT_CONTEXT: "default",
  getContext: (name?: string) => h.contexts[name ?? "default"] ?? {},
  addContext: (name: string, opts: { apiUrl?: string; dashboardUrl?: string; token?: string }) => {
    h.added.push({ name, opts });
  },
  setActiveContext: vi.fn(),
}));
vi.mock("../../src/lib/caps", () => ({ fetchCaps: async () => ({}) }));

import { loginCommand } from "../../src/commands/login";
import { LOCAL_API_URL, LOCAL_DASHBOARD_URL } from "@repo/core";
import { runCommand, stubFetch, type FetchStub } from "../helpers/harness";

let fetchStub: FetchStub;
beforeEach(() => {
  h.contexts = {};
  h.added = [];
  fetchStub = stubFetch(() => ({ status: 200, json: [] })); // /api/tokens validation passes
});
afterEach(() => fetchStub.restore());

describe("openship login endpoint preservation", () => {
  it("re-login without --api-url keeps the context's saved endpoints (not localhost)", async () => {
    h.contexts.prod = {
      apiUrl: "https://api.prod.example.com",
      dashboardUrl: "https://dash.prod.example.com",
      token: "old",
    };

    const { code } = await runCommand(loginCommand, ["--token", "opsh_pat_test", "--context", "prod"]);

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
    h.contexts.prod = { apiUrl: "https://api.prod.example.com", dashboardUrl: "https://dash.prod.example.com", token: "old" };

    await runCommand(loginCommand, [
      "--token", "opsh_pat_test",
      "--context", "prod",
      "--api-url", "https://api.staging.example.com",
    ]);

    expect(h.added.at(-1)?.opts.apiUrl).toBe("https://api.staging.example.com");
    expect(h.added.at(-1)?.opts.dashboardUrl).toBe("https://dash.prod.example.com");
  });

  it("uses local defaults for a new context", async () => {
    await runCommand(loginCommand, ["--token", "opsh_pat_test", "--context", "new"]);

    expect(fetchStub.calls[0].url).toBe(`${LOCAL_API_URL}/api/tokens`);
    expect(h.added.at(-1)?.opts).toMatchObject({ apiUrl: LOCAL_API_URL, dashboardUrl: LOCAL_DASHBOARD_URL });
  });

  it("keeps the saved API when only the dashboard is overridden", async () => {
    h.contexts.prod = { apiUrl: "https://api.prod.example.com", dashboardUrl: "https://dash.old.example.com" };
    await runCommand(loginCommand, ["--token", "opsh_pat_test", "--context", "prod", "--dashboard-url", "https://dash.new.example.com"]);

    expect(fetchStub.calls[0].url).toBe("https://api.prod.example.com/api/tokens");
    expect(h.added.at(-1)?.opts.dashboardUrl).toBe("https://dash.new.example.com");
  });

  it("does not overwrite a context when the replacement token is rejected", async () => {
    h.contexts.prod = { apiUrl: "https://api.prod.example.com", token: "old" };
    fetchStub.restore();
    fetchStub = stubFetch(() => ({ status: 401, json: { error: "Unauthorized" } }));

    const { code } = await runCommand(loginCommand, ["--token", "opsh_pat_invalid", "--context", "prod"]);

    expect(code).toBe(1);
    expect(h.added).toEqual([]);
  });
});
