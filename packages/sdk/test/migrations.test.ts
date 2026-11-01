import { describe, expect, it } from "vitest";
import { SDK_CAPABILITIES } from "@repo/contracts";
import { OpenshipClient } from "../src/client";

function fixture(reply: (url: URL, init: RequestInit) => Response) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const ship = new OpenshipClient({
    baseUrl: "https://cloud.example.test/control",
    token: "opsh_pat_fixture",
    organizationId: "org_fixture",
    fetch: async (url, init = {}) => {
      const parsed = new URL(String(url));
      if (parsed.pathname.endsWith("/health")) return Response.json({ sdk: SDK_CAPABILITIES });
      calls.push({ url: parsed, init });
      return reply(parsed, init);
    },
  });
  return { ship, calls };
}
describe("remote migration workflows", () => {
  it("moves a project to an owned Cloud server through the same migration operation with no implicit cutover", async () => {
    const f = fixture(() =>
      Response.json({ success: true, migrationId: "mig_one", confirmationToken: "review-token" }),
    );
    expect(
      await f.ship.migrations.moveProject({
        projectId: "proj_one",
        targetServerId: "srv_cloud",
        intent: "copy",
        newName: "copy",
      }),
    ).toMatchObject({ migrationId: "mig_one" });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url.pathname).toBe("/control/api/migration/project");
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      projectId: "proj_one",
      targetServerId: "srv_cloud",
      intent: "copy",
      newName: "copy",
    });
    expect(new Headers(f.calls[0].init.headers).get("x-organization-id")).toBe("org_fixture");
  });
  it("keeps an invalidated cutover token and chosen retention policy unchanged instead of retrying destructively", async () => {
    const f = fixture(() =>
      Response.json({ error: "Invalid confirmation token" }, { status: 409 }),
    );
    await expect(
      f.ship.migrations.cutover("mig_one", { confirmationToken: "expired", kill: false }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      confirmationToken: "expired",
      kill: false,
    });
  });
  it("does not retry an uncertain migration start or substitute name-only service selection", async () => {
    const f = fixture(() => {
      throw new TypeError("Connection lost after dispatch");
    });
    const input = {
      projectName: "orders",
      sourceServerId: "srv_old",
      targetServerId: "srv_new",
      serviceNames: ["api"],
      serviceContainerIds: ["container-exact"],
    };
    await expect(f.ship.migrations.start(input)).rejects.toThrow("Connection lost");
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual(input);
  });
  it("resumes only the supplied paths, preserving overrides and explicit skipped items", async () => {
    const f = fixture(() => Response.json({ success: true }));
    const choice = { overrides: { "/old/data": "/recovered/data" }, skip: ["bind:/old/cache"] };
    await f.ship.migrations.resume("mig_one", choice);
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual(choice);
    expect(f.calls).toHaveLength(1);
  });
  it("validates source credentials and selected env keys without contacting either server", async () => {
    const f = fixture(() => {
      throw new Error("Must not dispatch");
    });
    // @ts-expect-error Migration-only access cannot use the local SSH agent.
    await expect(
      f.ship.migrations.createSource({ sshHost: "server.test", sshAuthMethod: "agent" }),
    ).rejects.toThrow();
    await expect(
      f.ship.migrations.revealEnv({ serverId: "srv", containerId: "container", keys: [] }),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it("reattaches by GET and preserves failed terminal events", async () => {
    const f = fixture(
      () =>
        new Response('event: complete\ndata: {"type":"complete","status":"failed"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const events = [];
    for await (const event of f.ship.migrations.events("mig/one")) events.push(event);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].init.method ?? "GET").toBe("GET");
    expect(f.calls[0].url.pathname).toBe("/control/api/migration/migrations/mig%2Fone/stream");
    expect(events[0].data).toContain('"failed"');
  });
  it("retains a pending decision and represents unknown transfer size honestly", async () => {
    const result = {
      success: true,
      run: {
        id: "mig_one",
        mode: "cross_server",
        status: "partial",
        confirmationToken: "token",
        pendingPrompt: null,
        pendingItems: [{ key: "path:/data", kind: "path", source: "/data", reason: "missing" }],
      },
      progress: { task: "database", kind: "volume", movedBytes: 100, totalBytes: null },
    };
    const f = fixture(() => Response.json(result));
    expect(await f.ship.migrations.get("mig_one")).toEqual(result);
  });
});
