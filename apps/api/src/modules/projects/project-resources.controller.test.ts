import type { ExecutionContext } from "@repo/platform";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { ProjectResources } from "@repo/core";

const h = vi.hoisted(() => ({
  getResources: vi.fn(),
  updateResources: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("../../lib/request-context", () => ({
  getRequestContext: () => ({ userId: "user-1", organizationId: "org-1" }),
}));

vi.mock("../../lib/permission", () => ({
  permission: { assert: vi.fn(async () => {}) },
}));

vi.mock("../../lib/audit", () => ({
  audit: { recordAsync: h.audit },
  auditContextFrom: vi.fn(() => ({})),
}));

vi.mock("@repo/platform/engine/modules/projects/project.service", () => ({
  getResources: h.getResources,
  updateResources: h.updateResources,
}));

import { getResources, updateResources } from "./project.controller";

const resources = {
  production: { cpuCores: 1, memoryMb: 1024, diskMb: 16384 },
  build: { cpuCores: 2, memoryMb: 2048, diskMb: 32768 },
  sleepMode: "auto_sleep",
  port: 3000,
  tier: "medium",
  capacity: { cpuCores: 8, memoryMb: 16384, source: "docker" },
  requiresLimit: false,
} satisfies ProjectResources;

function app() {
  const api = new Hono();
  api.get("/projects/:id/resources", getResources);
  api.patch("/projects/:id/resources", updateResources);
  return api;
}

describe("project resources response envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getResources.mockResolvedValue(resources);
    h.updateResources.mockResolvedValue(resources);
  });

  it("includes success and data when resources are read", async () => {
    const response = await app().request("/projects/project-1/resources");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: resources });
    expect(h.getResources).toHaveBeenCalledWith("project-1", "org-1");
  });

  it("includes success and data when resources are updated", async () => {
    const body = { production: { tier: "medium" } };
    const response = await app().request("/projects/project-1/resources", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true, data: resources });
    expect(h.updateResources).toHaveBeenCalledWith("project-1", body, "org-1");
    expect(h.audit).toHaveBeenCalledOnce();
  });
});

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  authorization: { authorize: async (ctx: ExecutionContext) => ctx },
}));

vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({
  audit: { recordAsync: h.audit },
  auditContextFrom: vi.fn(() => ({})),
}));
