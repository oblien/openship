import { describe, expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";
import { createShip } from "../src/native";
import { createAuthorization, createPlatform, type ProjectDependencies, type VerifiedIdentity } from "@repo/platform";
import { alice, authorizationFixture } from "../../platform/test/fixtures";
import { projectFixture } from "../../contracts/test/fixtures";

describe("project log facades", () => {
  it("validates home and encodes request-log selectors without changing unavailable cloud results", async () => {
    const home = { success: true, projects: [projectFixture()], numbers: { total_projects: 1, total_active_projects: 1, total_deployments: 0, total_success_deployments: 0 }, otherOrgs: [] };
    const fetch = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url));
      if (path.pathname.endsWith("/home")) return Response.json(home);
      expect(path.pathname).toContain("project%2Fa/server-logs/");
      expect(path.searchParams.get("domain")).toBe("app.example.com");
      if (path.pathname.endsWith("/stream-token")) return Response.json({ kind: "unavailable" });
      expect(path.searchParams.get("limit")).toBe("20");
      return Response.json({ logs: [{ path: "/café" }] });
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch });
    expect(await client.projects.getHome()).toEqual(home);
    expect(await client.projects.getServerLogStreamToken("project/a", { domain: "app.example.com" })).toEqual({ kind: "unavailable" });
    expect(await client.projects.recentServerLogs("project/a", { domain: "app.example.com", limit: 20 })).toEqual({ logs: [{ path: "/café" }] });
    await expect(client.projects.recentServerLogs("project/a", { limit: 201 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it.each(["streamServerLogs", "streamRuntimeLogs"] as const)("decodes remote %s and cancels on early return", async method => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('event: log\ndata: {"message":"日本語"}\n\n')); }, cancel,
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: async () => new Response(stream, { headers: { "content-type": "text/event-stream" } }) });
    for await (const event of client.projects[method]("project-a")) {
      expect(event).toEqual({ event: "log", data: '{"message":"日本語"}' });
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
  });
  it("decodes native provider bytes and revalidates host identity even between events in one chunk", async () => {
    const state = authorizationFixture();
    state.members.set("org-a:alice", { id: "a", role: "owner" });
    state.projects.set("project-a", { organizationId: "org-a" });
    const closed = vi.fn();
    const bytes = new TextEncoder().encode(': comment\n\nevent: request\ndata: {"path":"/café"}\n\nevent: request\ndata: second\n\n');
    const platform = createPlatform({ authorization: createAuthorization(state), trigger: vi.fn(), present: vi.fn(), recordAudit: vi.fn(), forward: vi.fn(),
      projects: { openServerLogs: async () => (async function* () { try { for (const byte of bytes) yield new Uint8Array([byte]); } finally { closed(); } })() } as unknown as ProjectDependencies,
    });
    let identity: VerifiedIdentity | null = alice;
    const ship = createShip({ platform, identity: { resolve: async () => identity } });
    const scoped = await ship.scope({ identity: "verified", organizationId: "org-a" });
    const iterator = scoped.projects.streamServerLogs("project-a")[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ event: "request", data: '{"path":"/café"}' });
    identity = null;
    await expect(iterator.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(closed).toHaveBeenCalledOnce();
  });
});
