import { describe, expect, it, vi } from "vitest";
import {
  createAuthorization,
  createPlatform,
  type ProjectDependencies,
  type VerifiedIdentity,
} from "@repo/platform";
import { alice, authorizationFixture } from "../../platform/test/fixtures";
import { OpenshipClient } from "../src/client";
import { createShip } from "../src/native";

describe("routing retry facades", () => {
  it("posts a streamed repair and preserves the actual failure and terminal event", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          [
            'event: session\ndata: {"type":"session"}\n\n',
            'event: log\ndata: {"type":"log","message":"api.example.com: SSH unreachable","level":"error"}\n\n',
            'event: complete\ndata: {"type":"complete","status":"failed"}\n\n',
          ].join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch });
    const events = [];
    for await (const event of client.projects.retryRoutingStream("project/a")) events.push(event);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/api/projects/project%2Fa/routing/retry/stream");
    expect(options.method).toBe("POST");
    expect(events.map((event) => event.event)).toEqual(["session", "log", "complete"]);
    expect(JSON.parse(events[1]!.data).message).toBe("api.example.com: SSH unreachable");
    expect(JSON.parse(events[2]!.data).status).toBe("failed");
  });

  it("keeps a server rejection actionable instead of replacing it with a generic timeout", async () => {
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: async () =>
        Response.json(
          {
            error: "Host execution is disabled by this native installation's policy",
            code: "HOST_EXECUTION_DISABLED",
          },
          { status: 403 },
        ),
    });
    await expect(
      client.projects.retryRoutingStream("project-a")[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      status: 403,
      message: "Host execution is disabled by this native installation's policy",
    });
  });

  it("reattaches over GET with the exact session ID, even when that repair has finished", async () => {
    const fetch = vi.fn(
      async () =>
        new Response('event: complete\ndata: {"type":"complete","status":"completed"}\n\n', {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch });
    const events = [];
    for await (const event of client.projects.retryRoutingStream("project/a", {
      sessionId: "routing/a?",
    }))
      events.push(event);
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(options.method).toBe("GET");
    expect(new URL(url).pathname).toBe("/api/projects/project%2Fa/routing/retry/stream");
    expect(new URL(url).searchParams.get("sessionId")).toBe("routing/a?");
    expect(events).toHaveLength(1);
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("runs natively without HTTP and revalidates identity before disclosing each event", async () => {
    const state = authorizationFixture();
    state.members.set("org-a:alice", { id: "a", role: "owner" });
    state.projects.set("project-a", { organizationId: "org-a" });
    const unsubscribe = vi.fn();
    let emit!: (event: string, data: string) => boolean;
    const platform = createPlatform({
      authorization: createAuthorization(state),
      trigger: vi.fn(),
      present: vi.fn(),
      recordAudit: vi.fn(),
      forward: vi.fn(),
      projects: {
        subscribeRoutingRetry: () => (write: typeof emit) => {
          emit = write;
          write("session", '{"type":"session"}');
          return { success: true, unsubscribe };
        },
      } as unknown as ProjectDependencies,
    });
    let identity: VerifiedIdentity | null = alice;
    const scoped = await createShip({
      platform,
      identity: { resolve: async () => identity },
    }).scope({ identity: "verified", organizationId: "org-a" });
    const iterator = scoped.projects.retryRoutingStream("project-a")[Symbol.asyncIterator]();
    expect((await iterator.next()).value?.event).toBe("session");
    emit("log", '{"message":"Routes restored"}');
    expect((await iterator.next()).value?.data).toContain("Routes restored");
    identity = null;
    emit("log", '{"message":"Private server details"}');
    await expect(iterator.next()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
