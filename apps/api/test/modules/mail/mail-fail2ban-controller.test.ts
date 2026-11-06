import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { AppError } from "@repo/core";

const h = vi.hoisted(() => ({
  cloud: false,
  inOrg: true,
  canManage: false,
  assert: vi.fn(),
  status: vi.fn(),
  ban: vi.fn(),
  unban: vi.fn(),
}));
vi.mock("../../../src/lib/permission", () => ({
  permission: { assert: h.assert },
  checkPermissionOnResource: async () => h.canManage,
}));
vi.mock("../../../src/lib/request-context", () => ({
  getRequestContext: () => ({ organizationId: "org-mail", userId: "mail-reader" }),
}));
vi.mock("../../../src/lib/controller-helpers", () => ({
  assertNotCloud: (c: any) => (h.cloud ? c.json({ error: "Not available" }, 404) : undefined),
  isServerInOrg: async () => h.inOrg,
  param: (c: any, name: string) => c.req.param(name),
}));
vi.mock("../../../src/modules/mail/admin/components.service", () => ({
  getFail2banStatus: h.status,
  banFail2banIp: h.ban,
  unbanFail2banIp: h.unban,
}));
import {
  getFail2banStatusHandler,
  banFail2banIpHandler,
  unbanFail2banIpHandler,
} from "../../../src/modules/mail/admin/admin.controller";
import { handleApiError } from "../../../src/middleware/error-handler";

const app = new Hono()
  .onError((error, c) => handleApiError(error, c))
  .get("/:serverId/status", getFail2banStatusHandler)
  .post("/:serverId/ban", banFail2banIpHandler)
  .post("/:serverId/unban", unbanFail2banIpHandler);
function request(action: "status" | "ban" | "unban", body?: unknown) {
  return app.request(
    `/srv-mail/${action}`,
    action === "status"
      ? {}
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body ?? { ip: "203.0.113.10", jail: "postfix" }),
        },
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  h.cloud = false;
  h.inOrg = true;
  h.canManage = false;
  h.assert.mockResolvedValue(undefined);
  h.status.mockResolvedValue({ jails: [], details: {}, checkedAt: "2026-11-06T08:00:00Z" });
  h.ban.mockResolvedValue({ success: true, output: "1" });
  h.unban.mockResolvedValue({ success: true, output: "1" });
});

describe("Fail2ban HTTP scope and permissions", () => {
  it.each(["status", "ban", "unban"] as const)(
    "excludes Cloud and other organizations before %s can touch a server",
    async (action) => {
      h.cloud = true;
      expect((await request(action)).status).toBe(404);
      expect(h.assert).not.toHaveBeenCalled();
      h.cloud = false;
      h.inOrg = false;
      expect((await request(action)).status).toBe(404);
      expect(h.status).not.toHaveBeenCalled();
      expect(h.ban).not.toHaveBeenCalled();
      expect(h.unban).not.toHaveBeenCalled();
    },
  );
  it("returns server-computed read-only capability and requires read permission", async () => {
    const response = await request("status");
    expect(await response.json()).toMatchObject({ canManage: false });
    expect(h.assert).toHaveBeenLastCalledWith(expect.anything(), {
      resourceType: "mail_server",
      resourceId: "srv-mail",
      action: "read",
    });
  });
  it.each(["ban", "unban"] as const)(
    "requires administrator permission before %s",
    async (action) => {
      h.assert.mockRejectedValueOnce(new AppError("Forbidden", 403, "FORBIDDEN"));
      expect((await request(action)).status).toBe(403);
      expect(h[action]).not.toHaveBeenCalled();
      expect(h.assert).toHaveBeenCalledWith(expect.anything(), {
        resourceType: "mail_server",
        resourceId: "srv-mail",
        action: "admin",
      });
    },
  );
  it("validates both action inputs and filtered status before executing", async () => {
    expect((await request("ban", { ip: "203.0.113.10" })).status).toBe(400);
    expect((await request("unban", { ip: "--all" })).status).toBe(400);
    expect((await app.request("/srv-mail/status?jail=--all")).status).toBe(400);
    expect(h.status).not.toHaveBeenCalled();
    expect(h.ban).not.toHaveBeenCalled();
    expect(h.unban).not.toHaveBeenCalled();
  });
  it("preserves the target, jail and IPv6 address through the HTTP handler", async () => {
    expect((await request("ban", { ip: "2001:db8::7", jail: "postfix-sasl" })).status).toBe(200);
    expect(h.ban).toHaveBeenCalledExactlyOnceWith("srv-mail", "2001:db8::7", "postfix-sasl");
  });
});
