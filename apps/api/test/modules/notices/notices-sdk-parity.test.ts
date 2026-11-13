import { afterEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { db, schema, repos, seedOwner } from "../jobs/_harness";
import { createShip } from "@repo/sdk/native";
import { OpenshipClient, OpenshipOperatorClient } from "@repo/sdk/client";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";
import { operatorNoticeOperations } from "@repo/platform/engine/modules/notices/notice.operations";
import { env } from "@repo/platform/engine/config/index";
import { noticeRoutes } from "../../../src/modules/notices/notice.routes";
import { handleApiError } from "../../../src/middleware/error-handler";

// app.request has no socket. Supply the trusted peer normally set by ingress.
const app = new Hono().onError(handleApiError)
  .use("*", async (c, next) => { c.set("clientIp", "127.0.0.1"); await next(); })
  .route("/api/notices", noticeRoutes);
const fetcher = ((url, init) => app.request(url as string, init)) as typeof fetch;
const remote = new OpenshipClient({ baseUrl: "http://openship.test", fetch: fetcher });
const operator = new OpenshipOperatorClient({ baseUrl: "http://openship.test", internalToken: env.INTERNAL_TOKEN!, fetch: fetcher });
afterEach(async () => { await db.delete(schema.systemNotice); });

describe("shared public notices and explicit operator administration", () => {
  it("preserves advisory presentation and canonical persisted timestamps across both interfaces", async () => {
    const actor = await seedOwner();
    const ship = createShip({ platform: getPlatformKernel(), identity: { resolve: async () => ({ user: (await repos.user.findById(actor.userId))!, sessionId: "notices" }) } });
    const native = await ship.scope({ identity: "verified", organizationId: actor.orgId });
    expect("operator" in native).toBe(false);
    expect(Object.keys(native.notices)).toEqual(["list"]);
    const notice = await operator.notices.create({ title: " Maintenance ", message: " Status details ", severity: "critical", actionLabel: " Status ", actionUrl: " https://status.example.test ", targetType: "mail", targetId: "mail-1" });
    const rows = await operatorNoticeOperations.listAll();
    expect(rows).toEqual([notice]);
    expect(notice).toMatchObject({ title: "Maintenance", message: "Status details", active: true, startsAt: null, endsAt: null });
    const expected = { advisories: [{ id: notice.id, title: "Maintenance", message: "Status details", severity: "critical", announce: false, affects: "*", action: { kind: "open-url", label: "Status", url: "https://status.example.test" }, target: { type: "mail", id: "mail-1" } }] };
    expect(await native.notices.list()).toEqual(expected);
    expect(await remote.notices.list()).toEqual(expected);
    expect(JSON.stringify(expected)).not.toContain("createdAt");
  });

  it("never treats a tenant or instance administrator's bearer token as operator authority", async () => {
    for (const actor of [await seedOwner(), await seedOwner({ instanceAdmin: true })]) {
      for (const [method, path] of [["GET", "/all"], ["POST", ""], ["DELETE", "/ntc-any"]]) {
        const response = await app.request(`/api/notices${path}`, { method, headers: actor.auth, ...(method === "POST" && { body: JSON.stringify({ title: "Unauthorized", message: "Blocked" }) }) });
        expect(response.status).toBe(401);
      }
    }
    expect(await operator.notices.listAll()).toEqual([]);
    const rejected = new OpenshipOperatorClient({ baseUrl: "http://openship.test", internalToken: "wrong", fetch: fetcher });
    await expect(rejected.notices.create({ title: "Blocked", message: "Blocked" })).rejects.toMatchObject({ status: 401 });
  });

  it("rejects invalid URLs, dates, and display windows before writing through either adapter", async () => {
    for (const client of [operatorNoticeOperations, operator.notices]) {
      for (const invalid of [
        { title: " " }, { actionUrl: "javascript:alert(1)" }, { actionUrl: "https://" },
        { startsAt: "invalid" }, { startsAt: "2026-02-30" }, { startsAt: "2026-01-01T10:00:00" },
        { startsAt: "2026-04-02", endsAt: "2026-04-01" },
      ]) await expect(client.create({ title: "Notice", message: "Details", ...invalid })).rejects.toMatchObject({ code: "INVALID_NOTICE" });
    }
    expect(await operator.notices.listAll()).toEqual([]);
  });

  it("keeps scheduled and cleared notices out of the public list while retaining operator history", async () => {
    const current = await operatorNoticeOperations.create({ title: "Current", message: "Details", severity: "unknown", targetType: "unknown" });
    await operator.notices.create({ title: "Future", message: "Details", startsAt: "2099-01-01" });
    await operator.notices.create({ title: "Past", message: "Details", endsAt: "2000-01-01" });
    expect(await remote.notices.list()).toEqual({ advisories: [{ id: current.id, title: "Current", message: "Details", severity: "info", announce: false, affects: "*" }] });
    await operator.notices.remove(current.id);
    await operatorNoticeOperations.remove(current.id);
    expect(await remote.notices.list()).toEqual({ advisories: [] });
    const rows = await operator.notices.listAll();
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.id === current.id)?.active).toBe(false);
  });
});
