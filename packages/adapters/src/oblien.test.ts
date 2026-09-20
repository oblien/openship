import { afterEach, describe, expect, it, vi } from "vitest";
import { Oblien } from "./oblien";
afterEach(() => vi.unstubAllGlobals());
describe("Oblien SDK transport", () => {
  it("propagates an HTTP quota refusal even without success:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "NAMESPACE_LIMIT_REACHED" }, { status: 409 })));
    const client = new Oblien({ token: "scoped-test-token" });
    await expect(client.workspaces.create({ namespace: "tenant-a", wait_ready: false })).rejects.toMatchObject({ status: 409, code: "NAMESPACE_LIMIT_REACHED" });
  });
  it("rejects an error HTTP status even when a payload claims success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, workspace: { id: "not-created" } }, { status: 503 })));
    await expect(new Oblien({ token: "test" }).workspaces.create({ wait_ready: false })).rejects.toMatchObject({ status: 503 });
  });
  it("normalizes the provider's HTTP 200 namespace-validation refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ valid: false, error: "namespace is full", code: "NAMESPACE_LIMIT_REACHED" })));
    await expect(new Oblien({ token: "test" }).workspaces.create({ wait_ready: false })).rejects.toMatchObject({ status: 409, code: "NAMESPACE_LIMIT_REACHED" });
  });
  it("keeps official request formatting and never follows authenticated redirects", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, workspace: { id: "ws-a", namespace: "tenant-a" } }));
    vi.stubGlobal("fetch", fetcher);
    const client = new Oblien({ clientId: "test-owner", clientSecret: "test-secret" });
    await client.workspaces.create({ namespace: "tenant-a", cpus: 2, wait_ready: false });
    const [url, init] = fetcher.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.pathname).toBe("/workspace"); expect(init.redirect).toBe("error"); expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init.body as string)).toMatchObject({ namespace: "tenant-a", config: { cpus: 2 } });
  });
  it("tracks token refresh and authentication restore without mixing scopes", async () => {
    const headers: Headers[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => { headers.push(new Headers(init.headers)); return Response.json({ success: true, workspaces: [] }); }));
    const client = new Oblien({ clientId: "test-owner", clientSecret: "test-secret" });
    await client.workspaces.list(); client.setToken("namespace-token"); await client.workspaces.list(); client._http.restoreAuth(); await client.workspaces.list();
    expect(headers[0]!.get("X-Client-ID")).toBe("test-owner");
    expect(headers[1]!.get("Authorization")).toBe("Bearer namespace-token"); expect(headers[1]!.has("X-Client-Secret")).toBe(false);
    expect(headers[2]!.get("X-Client-ID")).toBe("test-owner"); expect(headers[2]!.has("Authorization")).toBe(false);
  });
  it("does not expose provider error details or tokens", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "scope_denied", message: "private-secret", details: { token: "private-secret" } }, { status: 403 })));
    const error = await new Oblien({ token: "test" }).workspaces.get("ws-b").catch(error => error);
    expect(error.message).not.toContain("private-secret"); expect(error.details).toBeUndefined(); expect(error.status).toBe(403);
  });
  it("rejects requests that escape the configured API origin", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(new Oblien({ token: "test" })._http.request({ method: "GET", path: "//another-host.example/workspace" })).rejects.toThrow("escaped");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("does not issue an already-cancelled workspace creation", async () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const controller = new AbortController();
    const reason = new Error("Deployment cancelled"); controller.abort(reason);
    await expect(new Oblien({ token: "test" }).workspaces.create({ wait_ready: false }, { signal: controller.signal })).rejects.toBe(reason);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves SDK cancellation during a request instead of returning a retryable provider error", async () => {
    let observed: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observed = init.signal!;
      observed.addEventListener("abort", () => reject(observed!.reason), { once: true });
    })));
    const controller = new AbortController();
    const reason = new Error("Deployment cancelled");
    const pending = new Oblien({ token: "test" }).workspaces.create({ wait_ready: false }, { signal: controller.signal });
    const result = expect(pending).rejects.toBe(reason);
    controller.abort(reason);
    await result;
    expect(observed?.aborted).toBe(true);
  });
});
