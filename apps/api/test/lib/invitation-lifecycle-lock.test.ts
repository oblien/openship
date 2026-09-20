import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { invitationLifecycleMiddleware } from "@/lib/invitation-lifecycle-lock";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("invitation lifecycle serialization", () => {
  it("routes every legacy terminal mutation to the shared lifecycle before the catch-all", () => {
    const routes = readFileSync(
      new URL("../../src/modules/auth/auth.routes.ts", import.meta.url),
      "utf8",
    );
    const catchAll = routes.indexOf('authRoutes.on(["GET", "POST"], "/*"');
    for (const path of [
      "/organization/accept-invitation",
      "/organization/reject-invitation",
      "/organization/cancel-invitation",
    ]) {
      const mounted = routes.indexOf(`"${path}"`);
      expect(mounted).toBeGreaterThan(-1);
      expect(mounted).toBeLessThan(catchAll);
    }
    expect(routes.slice(0, catchAll)).toContain("organizationController.acceptInvitation");
    expect(routes.slice(0, catchAll)).toContain("organizationController.cancelInvitation");
  });

  it("does not let accept and cancel for one invitation overlap", async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const entered: string[] = [];
    const app = new Hono();
    app.post("/:action", invitationLifecycleMiddleware, async (c) => {
      const action = c.req.param("action");
      entered.push(action);
      if (action === "accept") {
        firstEntered.resolve();
        await releaseFirst.promise;
      }
      return c.json({ action });
    });

    const accept = app.request("/accept", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitationId: "inv_same" }),
    });
    await firstEntered.promise;
    const cancel = app.request("/cancel", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitationId: "inv_same" }),
    });

    await vi.waitFor(() => expect(entered).toEqual(["accept"]));
    releaseFirst.resolve();
    await expect(Promise.all([accept, cancel])).resolves.toHaveLength(2);
    expect(entered).toEqual(["accept", "cancel"]);
  });

  it("does not globally serialize unrelated invitation ids", async () => {
    const bothEntered = deferred();
    const release = deferred();
    const entered: string[] = [];
    const app = new Hono();
    app.post("/:action", invitationLifecycleMiddleware, async (c) => {
      entered.push(c.req.param("action"));
      if (entered.length === 2) bothEntered.resolve();
      await release.promise;
      return c.body(null, 204);
    });

    const first = app.request("/first", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitationId: "inv_first" }),
    });
    const second = app.request("/second", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ invitationId: "inv_second" }),
    });

    await bothEntered.promise;
    expect(entered.sort()).toEqual(["first", "second"]);
    release.resolve();
    await Promise.all([first, second]);
  });
});
