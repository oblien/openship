import { describe, expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";
import { createShip } from "../src/native";
import { createAuthorization, createPlatform, type ProjectDependencies, type VerifiedIdentity } from "@repo/platform";
import { alice, authorizationFixture } from "../../platform/test/fixtures";
import { projectFixture } from "../../contracts/test/fixtures";

describe("project log facades", () => {
  it("keeps role, replica, and release selectors on both recent and streaming logs", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("role")).toBe("queue");
      expect(url.searchParams.get("replica")).toBe("2");
      expect(url.searchParams.get("deploymentId")).toBe("dep_active");
      expect(url.searchParams.get("tail")).toBe("5");
      return url.pathname.endsWith("/stream")
        ? new Response('event: log\ndata: {"message":"queue output"}\n\n', {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json({ data: [] });
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch });
    const selector = { role: "queue", replica: 2, deploymentId: "dep_active", tail: 5 };
    expect(await client.projects.runtimeLogs("project-a", selector)).toEqual([]);
    const events = [];
    for await (const event of client.projects.streamRuntimeLogs("project-a", selector))
      events.push(event);
    expect(events).toEqual([{ event: "log", data: '{"message":"queue output"}' }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    await expect(
      client.projects
        .streamRuntimeLogs("project-a", { role: "queue", replica: 0 })
        [Symbol.asyncIterator]()
        .next(),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
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
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: async url => String(url).endsWith("/stream-token")
      ? Response.json({ kind: "self-hosted" })
      : new Response(stream, { headers: { "content-type": "text/event-stream" } }) });
    for await (const event of client.projects[method]("project-a")) {
      expect(event).toEqual({ event: "log", data: '{"message":"日本語"}' });
      break;
    }
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("follows Cloud logs with only the issued stream token, never the instance credential", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.origin === "https://ship.test") {
        expect(url.pathname).toBe("/api/projects/project-a/server-logs/stream-token");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer instance-secret");
        return Response.json({ kind: "cloud", url: "https://edge.test/logs?domain=app.test", token: "edge-scoped-token" });
      }
      expect(url.origin).toBe("https://edge.test");
      expect(url.searchParams.get("domain")).toBe("app.test");
      expect(url.searchParams.get("token")).toBe("edge-scoped-token");
      expect(init).toMatchObject({ credentials: "omit", redirect: "error" });
      expect(new Headers(init?.headers).get("authorization")).toBeNull();
      expect(new Headers(init?.headers).get("cookie")).toBeNull();
      expect(new Headers(init?.headers).get("x-organization-id")).toBeNull();
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('event: request\ndata: {"path":"/"}\n\n')); }, cancel,
      }), { headers: { "content-type": "text/event-stream" } });
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", token: "instance-secret", fetch });
    for await (const event of client.projects.streamServerLogs("project-a")) {
      expect(event).toEqual({ event: "request", data: '{"path":"/"}' });
      break;
    }
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("fails explicitly for unavailable Cloud streaming without opening a self-hosted stream", async () => {
    const fetch = vi.fn(async () => Response.json({ kind: "unavailable" }));
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch });
    await expect(client.projects.streamServerLogs("project-a")[Symbol.asyncIterator]().next()).rejects.toMatchObject({ code: "SERVER_LOG_STREAM_UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["not-a-url", "file:///tmp/logs", "https://user:password@edge.test/logs", "https://edge.test/logs#fragment"])("rejects an unsafe stream URL %s before forwarding a token", async url => {
    const fetch = vi.fn(async () => Response.json({ kind: "cloud", url, token: "scoped-token" }));
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch });
    await expect(client.projects.streamServerLogs("project-a")[Symbol.asyncIterator]().next()).rejects.toThrow("Invalid request-log stream URL");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it.each(["connect", "read", "response"])("keeps signed Cloud URLs out of %s errors", async failure => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("https://ship.test/"))
        return Response.json({ kind: "cloud", url: "https://edge.test/logs", token: "scoped-secret" });
      if (failure === "connect") throw new Error(`Connection failed: ${url}`);
      if (failure === "response") return new Response(`Bad request: ${url}`, { status: 502 });
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error(`Read failed: ${url}`)); } }),
        { headers: { "content-type": "text/event-stream" } });
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch });
    const error = await client.projects.streamServerLogs("project-a")[Symbol.asyncIterator]().next().catch(error => error);
    expect(error).toMatchObject({ status: 502, body: null });
    expect(String(error)).not.toContain("scoped-secret");
    expect(JSON.stringify(error)).not.toContain("scoped-secret");
    expect(error).not.toHaveProperty("cause");
    expect(String(fetch.mock.calls[1][0])).toContain("token=scoped-secret");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves caller cancellation when the Cloud transport rejects", async () => {
    const controller = new AbortController();
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: async input => {
      if (String(input).startsWith("https://ship.test/"))
        return Response.json({ kind: "cloud", url: "https://edge.test/logs", token: "scoped-secret" });
      controller.abort();
      throw new Error(`Cancelled: ${input}`);
    } });
    const result = client.projects.streamServerLogs("project-a", {}, { signal: controller.signal })[Symbol.asyncIterator]().next();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    await expect(result).rejects.toBe(controller.signal.reason);
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
