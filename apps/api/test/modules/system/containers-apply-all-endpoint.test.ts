import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { handleApiError } from "../../../src/middleware/error-handler";

const h = vi.hoisted(() => ({
  applyAllContainers: vi.fn(async () => ({ started: [], skipped: [] })),
}));

vi.mock("@repo/platform/engine/lib/platform", () => ({
  getPlatformKernel: () => ({ servers: { applyAllContainers: h.applyAllContainers } }),
}));

vi.mock("../../../src/lib/operation-context", () => ({
  operationContext: () => ({ userId: "user_1", organizationId: "org_1" }),
  operationData: async (_c: unknown, value: Promise<unknown>) => value,
}));

import { applyAllContainers } from "../../../src/modules/system/server-containers.controller";

function app() {
  const instance = new Hono();
  instance.onError(handleApiError);
  instance.post("/api/system/containers/apply-all", applyAllContainers);
  return instance;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/system/containers/apply-all", () => {
  it("rejects malformed JSON without dispatching container operations", async () => {
    const response = await app().request("/api/system/containers/apply-all", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"intents":',
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body", code: "INVALID_JSON" });
    expect(h.applyAllContainers).not.toHaveBeenCalled();
  });

  it("keeps an omitted body as the default apply request", async () => {
    const response = await app().request("/api/system/containers/apply-all", { method: "POST" });

    expect(response.status).toBe(200);
    expect(h.applyAllContainers).toHaveBeenCalledWith(
      { userId: "user_1", organizationId: "org_1" },
      {},
    );
  });
});
