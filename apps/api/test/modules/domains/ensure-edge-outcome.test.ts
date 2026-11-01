import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { RequestContext } from "../../../src/lib/request-context";

const io = vi.hoisted(() => ({ prepare: vi.fn(), apply: vi.fn(), authorize: vi.fn() }));
vi.mock("../../../src/lib/permission", () => ({ permission: { assert: io.authorize } }));
vi.mock("@repo/platform/engine/modules/domains/project-edge.service", () => ({
  resolveProjectServer: async () => ({ serverId: "serving-box", isLocal: false }),
  prepareServerEdge: io.prepare,
  applyProjectEdgeRoutes: io.apply,
}));

import { ensureEdgeStream } from "../../../src/modules/domains/ensure-edge.controller";
import {
  getEdgeConsentSession,
  getActiveEdgeSessionForProject,
} from "../../../src/modules/domains/edge-consent-session";

const ctx = { userId: "owner", organizationId: "test-org" } as RequestContext;
const app = new Hono<{ Variables: { ctx: RequestContext } }>();
app.use("*", async (c, next) => {
  c.set("ctx", ctx);
  await next();
});
app.post("/projects/:id/routing/ensure-edge/stream", ensureEdgeStream);
let sequence = 0;
beforeEach(() => {
  vi.clearAllMocks();
  io.prepare.mockResolvedValue(undefined);
});

describe("edge preparation completion", () => {
  it.each([
    { warnings: [], status: "completed" },
    { warnings: ["app.example.test: HTTPS certificate could not be issued"], status: "failed" },
  ])("reports $status for the actual route and HTTPS outcome", async ({ warnings, status }) => {
    io.apply.mockResolvedValue(warnings);
    const id = `edge-outcome-${++sequence}`;
    const response = await app.request(`/projects/${id}/routing/ensure-edge/stream`, {
      method: "POST",
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    const events = [...text.matchAll(/^data:\s*(.+)$/gm)].map((match) => JSON.parse(match[1]));
    const session = events.find((event) => event.type === "session");
    expect(events.find((event) => event.type === "complete")).toMatchObject({ status });
    expect(getEdgeConsentSession(session.sessionId)?.status).toBe(status);
    expect(getActiveEdgeSessionForProject(id)).toBeNull();
    expect(
      events.some((event) => event.type === "log" && event.message.includes("route warnings")),
    ).toBe(warnings.length > 0);
    expect(io.authorize).toHaveBeenCalledWith(ctx, {
      resourceType: "project",
      resourceId: id,
      action: "write",
    });
  });
});
