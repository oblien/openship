import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, getApiErrorMessage } from "./client";
import { systemApi } from "./system";

afterEach(() => vi.unstubAllGlobals());
function respond(body: unknown, status = 200) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

describe("server response validation at the dashboard transport boundary", () => {
  it.each([
    ["read rate limit", () => systemApi.getRateLimit("srv_1"), {}],
    [
      "nested rate limit",
      () => systemApi.getRateLimit("srv_1"),
      { config: { rps: 1, burst: 2, whitelist: [null] } },
    ],
    ["save rate limit", () => systemApi.updateRateLimit("srv_1", { rps: 1 }), { success: true }],
    ["list fleet", () => systemApi.listAllContainers(), {}],
    ["nested fleet rows", () => systemApi.listAllContainers(), [{ server: {}, components: [] }]],
    ["scan fleet", () => systemApi.scanAllContainers(), [null]],
    ["apply fleet", () => systemApi.applyAllContainers(), { started: null, skipped: [] }],
    ["fleet progress", () => systemApi.applyingContainers(), { active: [{}], recent: [] }],
    ["infrastructure", () => systemApi.getServerInfrastructure("srv_1"), { networks: null }],
    [
      "removal preview",
      () => systemApi.serverDeletionPreview("srv_1"),
      { ok: true, preview: { workloads: [null] } },
    ],
    ["remove", () => systemApi.deleteServerEntry("srv_1"), { success: true }],
  ] as const)(
    "rejects malformed %s before it reaches React state",
    async (_name, request, body) => {
      respond(body);
      await expect(request()).rejects.toBeInstanceOf(ApiError);
    },
  );

  it("preserves valid read and saved rate-limit policies", async () => {
    const config = { rps: 10, burst: 20, whitelist: ["192.0.2.1/32"] };
    respond({ config });
    await expect(systemApi.getRateLimit("srv_1")).resolves.toEqual({ config });
    respond({ success: true, config });
    await expect(systemApi.updateRateLimit("srv_1", config)).resolves.toEqual({
      success: true,
      config,
    });
  });

  it("preserves structured failure details from an unreachable server", async () => {
    respond({ error: "SSH connection refused" }, 502);
    const failure = await systemApi.getRateLimit("srv_1").catch((error) => error);
    expect(getApiErrorMessage(failure)).toBe("SSH connection refused");
  });
});
