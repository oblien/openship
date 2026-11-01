import { describe, expect, it, vi } from "vitest";
import { HttpClient, parseSSE } from "../src/client";
import { SDK_CAPABILITIES } from "@repo/contracts";

describe("shared HTTP transport", () => {
  it.each(["https://elsewhere.test/api/projects", "../outside", "/../../outside", "https://ship.test/other"])(
    "does not send instance credentials outside its API: %s", async (path) => {
      for (const credential of [{ token: "secret" }, { internalToken: "operator-secret" }]) {
        const fetcher = vi.fn();
        const client = new HttpClient({ baseUrl: "https://ship.test", ...credential, fetch: fetcher });
        await expect(client.raw(path)).rejects.toThrow("configured instance");
        expect(fetcher).not.toHaveBeenCalled();
      }
    },
  );

  it("keeps operator credentials separate from bearer and tenant authority", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({}));
    expect(() => new HttpClient({ baseUrl: "https://ship.test", internalToken: "internal", organizationId: "org" })).toThrow("cannot be combined");
    expect(() => new HttpClient({ baseUrl: "https://ship.test", internalToken: "internal", token: "pat" })).toThrow("cannot be combined");
    const client = new HttpClient({ baseUrl: "https://ship.test", internalToken: async () => "internal", fetch: fetcher });
    await client.raw("/notices", { redirect: "follow" });
    const init = fetcher.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("X-Internal-Token")).toBe("internal");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(init.redirect).toBe("error");
  });

  it("does not let request headers replace a fixed tenant and never follows redirects", async () => {
    const fetcher = vi.fn(async (url: string, _init?: RequestInit) => Response.json(url.endsWith("/health") ? { sdk: SDK_CAPABILITIES } : { data: [] }));
    const client = new HttpClient({ baseUrl: "https://ship.test/prefix", organizationId: "org-a", fetch: fetcher });
    await client.raw("/projects", { headers: { "X-Organization-Id": "org-b", "X-Openship-Scope": "resource" }, redirect: "follow" });
    const [url, init] = fetcher.mock.calls[1]!;
    expect(url).toBe("https://ship.test/prefix/api/projects");
    expect(new Headers(init!.headers).get("X-Organization-Id")).toBe("org-a");
    expect(new Headers(init!.headers).get("X-Openship-Scope")).toBe("fixed");
    expect(init!.redirect).toBe("error");
  });

  it("cancels a pending credential lookup before making a mutation", async () => {
    const abort = new AbortController();
    const fetcher = vi.fn();
    const token = vi.fn(() => new Promise<string>(() => {}));
    const client = new HttpClient({ baseUrl: "https://ship.test", fetch: fetcher, token });
    const request = client.raw("/projects", { method: "POST", signal: abort.signal });
    await vi.waitFor(() => expect(token).toHaveBeenCalledOnce());
    abort.abort(new Error("cancelled"));
    await expect(request).rejects.toThrow("cancelled");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps pagination filters while replacing page parameters", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const query = new URL(url).searchParams;
      expect(query.get("projectId")).toBe("project-a");
      expect(query.getAll("page")).toHaveLength(1);
      return Response.json({ data: [query.get("page")], total: 2 });
    });
    const client = new HttpClient({ baseUrl: "https://ship.test", fetch: fetcher });
    const results = [];
    for await (const value of client.paginate("/deployments?projectId=project-a&page=9", { perPage: 1 })) results.push(value);
    expect(results).toEqual(["1", "2"]);
  });

  it("sends only upload-specific credentials to an external upload target", async () => {
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }));
    const client = new HttpClient({ baseUrl: "https://ship.test", token: "private-api-token", fetch: fetcher });
    await client.upload({ url: "https://storage.test/source", headers: { Authorization: "upload-token" } }, "archive");
    const init = fetcher.mock.calls[0]![1]!;
    expect(new Headers(init.headers).get("Authorization")).toBe("upload-token");
    expect(init.redirect).toBe("error");
  });

  it("releases a live event stream when a consumer stops iteration", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("data: one\n\n")); }, cancel,
    });
    for await (const event of parseSSE(stream)) { expect(event.data).toBe("one"); break; }
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("handles CR boundaries, UTF-8 chunks, and persistent event IDs", async () => {
    const bytes = new TextEncoder().encode("id: cursor\r\ndata: مرحبا\r\n\r\ndata: second\r\r");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); },
    });
    const events = [];
    for await (const event of parseSSE(stream)) events.push(event);
    expect(events).toEqual([
      { event: "message", id: "cursor", data: "مرحبا" },
      { event: "message", id: "cursor", data: "second" },
    ]);
  });
});
