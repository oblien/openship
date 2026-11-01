import { afterEach, describe, expect, it, vi } from "vitest";
import { Oblien, cloudWorkspaceCreationFailure } from "./oblien";
afterEach(() => vi.unstubAllGlobals());
describe("Oblien SDK transport", () => {
  it.each(["3", new Date(Date.now() + 30_000).toUTCString()])("preserves a gateway throttle and Retry-After %s without exposing its HTML", async (retryAfter) => {
    const fetcher = vi.fn(async () => new Response("<html>private gateway data</html>", {
      status: 429, headers: { "Retry-After": retryAfter },
    }));
    vi.stubGlobal("fetch", fetcher);
    const error = await new Oblien({ token: "test" }).workspaces.create({ wait_ready: false }).catch(error => error);
    expect(error).toMatchObject({ status: 429, code: "OBLIEN_RATE_LIMITED" });
    expect(error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(error.details.retryAfterSeconds).toBeLessThanOrEqual(30);
    expect(error.message).toContain("Retry after");
    expect(error.message).not.toContain("private");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["invalid", "-1", "99999999999999999999999"])("ignores invalid Retry-After %s", async (retryAfter) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503, headers: { "Retry-After": retryAfter } })));
    const error = await new Oblien({ token: "test" }).workspaces.get("ws").catch(error => error);
    expect(error.status).toBe(503);
    expect(error.details).toBeUndefined();
  });
  it("reads the provider egress pool from its fixed endpoint and strips credentials", async () => {
    const fetcher = vi.fn(async (_url: unknown) => Response.json({ success: true, proxies: [
      { ip: "8.8.4.4", country_code: "US", username: "pool-user", password: "pool-password", internal_id: "private-id" },
      { ip: "8.8.4.4", country_code: "US" },
      { ip: "1.1.1.1", country_code: null },
    ] }));
    vi.stubGlobal("fetch", fetcher);
    const choices = await new Oblien({ token: "fixture-token" }).listOutboundIps();
    expect(choices).toEqual([{ ip: "8.8.4.4", countryCode: "US" }, { ip: "1.1.1.1", countryCode: null }]);
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.oblien.com/zone/mine");
    expect(JSON.stringify(choices)).not.toMatch(/pool-user|pool-password|private-id/);
  });
  it("rejects an unreadable pool instead of presenting a successful empty picker", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, proxies: [{ ip: "not-an-ip", password: "private-password" }] })));
    await expect(new Oblien({ token: "fixture-token" }).listOutboundIps()).rejects.toMatchObject({ code: "OBLIEN_OUTBOUND_OPTIONS_INVALID" });
  });
  it("propagates an HTTP quota refusal even without success:false", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "NAMESPACE_LIMIT_REACHED" }, { status: 409 })));
    const client = new Oblien({ token: "scoped-test-token" });
    const error = await client.workspaces.create({ namespace: "tenant-a", wait_ready: false }).catch(error => error);
    expect(error).toMatchObject({ status: 409, code: "NAMESPACE_LIMIT_REACHED" });
    expect(cloudWorkspaceCreationFailure(error)).toMatchObject({ capacityRejected: true, rejected: true });
  });
  it("rejects an error HTTP status even when a payload claims success", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, workspace: { id: "not-created" } }, { status: 503 })));
    await expect(new Oblien({ token: "test" }).workspaces.create({ wait_ready: false })).rejects.toMatchObject({ status: 503 });
  });
  it.each(["NAMESPACE_LIMIT_REACHED", "SANDBOX_LIMIT_REACHED", "POOL_LIMIT_REACHED"])(
    "normalizes the provider's HTTP 200 %s refusal",
    async (code) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json({ valid: false, error: "capacity exceeded", code })),
      );
      await expect(
        new Oblien({ token: "test" }).workspaces.create({ wait_ready: false }),
      ).rejects.toMatchObject({ status: 409, code });
    },
  );
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
    expect(cloudWorkspaceCreationFailure(error)).toMatchObject({ capacityRejected: false, rejected: true });
  });
  it("keeps safe namespace allocation diagnostics and the request ID in deploy errors", async () => {
    const requestId = "5d66e628-76c5-4a15-93c7-0eaa02f21097";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "NAMESPACE_LIMIT_REACHED",
            message: "private-account-data",
            requestId,
            details: {
              resource: "cpus",
              requested: 5,
              effectiveLimit: 4,
              unit: "private-secret",
              enforcementScope: "namespace",
              namespace: "private-namespace",
              token: "private-secret",
            },
          },
          { status: 409 },
        ),
      ),
    );
    const error = await new Oblien({ token: "test" }).workspaces
      .create({ wait_ready: false })
      .catch((error) => error);
    expect(error).toMatchObject({
      status: 409,
      code: "NAMESPACE_LIMIT_REACHED",
      requestId,
      details: {
        resource: "cpus",
        requested: 5,
        effectiveLimit: 4,
        unit: "vCPU",
        enforcementScope: "namespace",
      },
    });
    expect(error.message).toContain("5 vCPU");
    expect(error.message).toContain("4 vCPU");
    expect(error.message).toContain("per workspace");
    expect(error.message).toContain(requestId);
    expect(JSON.stringify(error)).not.toContain("private-");
  });
  it("distinguishes the namespace allocation pool from a single workspace limit", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "NAMESPACE_LIMIT_REACHED",
            details: {
              violations: [
                {
                  resource: "memory_mb",
                  requested: 8192,
                  effectiveLimit: 16384,
                  currentUsage: 12288,
                  enforcementScope: "namespace_allocated_pool",
                },
                {
                  resource: "cpus",
                  requested: 2,
                  effectiveLimit: 32,
                  currentUsage: 31,
                  enforcementScope: "account_pool",
                },
              ],
            },
          },
          { status: 409 },
        ),
      ),
    );
    const error = await new Oblien({ token: "test" }).workspaces
      .create({ wait_ready: false })
      .catch((error) => error);
    expect(error.details.violations).toEqual([
      {
        resource: "memory_mb",
        requested: 8192,
        effectiveLimit: 16384,
        currentUsage: 12288,
        enforcementScope: "namespace_allocated_pool",
        unit: "MB",
      },
    ]);
    expect(error.message).toContain("namespace total");
    expect(error.message).toContain("12288 MB");
    expect(JSON.stringify(error)).not.toContain("account_pool");
  });
  it("does not reflect malformed diagnostics, request IDs or provider messages", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "NAMESPACE_LIMIT_REACHED",
            requestId: "private-token",
            message: "private-secret",
            details: {
              violations: [
                {
                  resource: "cpus",
                  requested: "private-secret",
                  effectiveLimit: 4,
                  enforcementScope: "namespace",
                },
                {
                  resource: "memory_mb",
                  requested: -1,
                  effectiveLimit: 1024,
                  enforcementScope: "namespace",
                },
                {
                  resource: "private-secret",
                  requested: 1,
                  effectiveLimit: 2,
                  enforcementScope: "namespace",
                },
              ],
            },
          },
          { status: 409 },
        ),
      ),
    );
    const error = await new Oblien({ token: "test" }).workspaces
      .create({ wait_ready: false })
      .catch((error) => error);
    expect(error.details).toBeUndefined();
    expect(error.requestId).toBeUndefined();
    expect(error.message).not.toContain("private-");
  });
  it("preserves only a failed creation's workspace identity for cleanup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            code: "CREATE_FAILED",
            message: "private-account-data",
            details: {
              workspace_id: "ws-failed",
              token: "private-secret",
              workspace: { env: { SECRET: "private-secret" } },
            },
          },
          { status: 422 },
        ),
      ),
    );
    const error = await new Oblien({ token: "test" }).workspaces
      .create({ wait_ready: false })
      .catch((error) => error);
    expect(error).toMatchObject({
      status: 422,
      code: "CREATE_FAILED",
      details: { workspace_id: "ws-failed" },
    });
    expect(cloudWorkspaceCreationFailure(error)).toEqual({ workspaceId: "ws-failed", capacityRejected: false, rejected: false });
    expect(JSON.stringify(error)).not.toContain("private-");
    expect(error.message).not.toContain("private-");
  });
  it.each([
    ["plan_limit_exceeded", "provider account's resource capacity"],
    ["namespace_limit_exceeded", "provider account has reached its namespace limit"],
    ["NAMESPACE_LIMIT_REACHED", "your organization's Cloud resource limits"],
  ])("explains %s without leaking the provider's raw error body", async (code, description) => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      error: code, message: "private-account-data", details: { violations: ["private-namespace-name"] },
    }, { status: 400 })));
    const error = await new Oblien({ token: "scoped-test-token" }).workspaces.get("ws-a").catch(error => error);
    expect(error).toMatchObject({ status: 400, code });
    expect(error.message).toContain(description);
    expect(error.message).not.toContain("private-");
    expect(error.details).toBeUndefined();
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
