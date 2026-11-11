import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@repo/platform/engine/lib/safe-fetch", () => ({ safeFetch: h.fetch }));
import {
  providerJson,
  railwayQuery,
  vercelRequest,
} from "@repo/platform/engine/modules/credentials/provider-api";
beforeEach(() => {
  vi.resetAllMocks();
  h.fetch.mockResolvedValue({ ok: true, json: async () => ({ data: { value: true } }) });
});
describe("connection provider HTTP boundary", () => {
  it("never accepts a provider origin from discovered configuration", async () => {
    for (const url of [
      "http://127.0.0.1/admin",
      "https://api.vercel.com.attacker.example",
      "https://backboard.railway.com.attacker.example",
    ])
      await expect(providerJson(new URL(url))).rejects.toMatchObject({
        code: "CONNECTION_ENDPOINT_INVALID",
      });
    expect(h.fetch).not.toHaveBeenCalled();
  });
  it("keeps project tokens and workspace tokens in their documented authorization headers", async () => {
    await railwayQuery(
      {
        provider: "railway",
        publicFields: { tokenType: "project" },
        secrets: { apiToken: "project-secret" },
      },
      "query { projectToken { id } }",
    );
    expect(h.fetch.mock.calls[0][1].headers).toEqual({
      "Content-Type": "application/json",
      "Project-Access-Token": "project-secret",
    });
    await railwayQuery(
      {
        provider: "railway",
        publicFields: { tokenType: "workspace" },
        secrets: { apiToken: "workspace-secret" },
      },
      "query { projects { id } }",
    );
    expect(h.fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer workspace-secret");
  });
  it("always uses the selected connection's team and bounds provider responses", async () => {
    await vercelRequest(
      {
        provider: "vercel",
        publicFields: { teamId: "owned-team" },
        secrets: { apiToken: "secret" },
      },
      "/v9/projects",
      { teamId: "other-team" },
    );
    const [url, options] = h.fetch.mock.calls[0];
    expect(new URL(url).searchParams.get("teamId")).toBe("owned-team");
    expect(options).toMatchObject({ timeoutMs: 30_000, maxBodyBytes: 8 * 1024 * 1024 });
  });
  it("redacts HTTP, GraphQL and transport error bodies", async () => {
    h.fetch.mockResolvedValue({ ok: false, status: 403, text: async () => "secret" });
    await expect(providerJson(new URL("https://api.vercel.com/v9/projects"))).rejects.toMatchObject(
      { code: "CONNECTION_ACCESS_DENIED" },
    );
    h.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ errors: [{ message: "secret" }] }),
    });
    await expect(
      railwayQuery(
        { provider: "railway", publicFields: {}, secrets: { apiToken: "token" } },
        "query {}",
      ),
    ).rejects.toMatchObject({ code: "RAILWAY_QUERY_FAILED" });
    h.fetch.mockRejectedValue(new Error("secret"));
    await expect(providerJson(new URL("https://api.vercel.com/v9/projects"))).rejects.toMatchObject(
      { code: "CONNECTION_UNAVAILABLE" },
    );
  });
});
