import { describe, expect, it, vi } from "vitest";
import { OpenshipClient } from "../src/client";
import { serviceFixture } from "../../contracts/test/fixtures";
import type { ServiceOperations } from "@repo/contracts";

const service = serviceFixture("service/a", "project/a");
const cases: Array<{
  name: keyof Omit<ServiceOperations, "streamLogs">;
  child?: boolean;
  method: string;
  path: string;
  input?: unknown;
  body?: unknown;
  result: unknown;
  response?: unknown;
}> = [
  {
    name: "list",
    method: "GET",
    path: "",
    result: [service],
    response: { success: true, services: [service] },
  },
  {
    name: "create",
    method: "POST",
    path: "",
    input: { name: "web" },
    result: service,
    response: { success: true, service },
  },
  {
    name: "sync",
    method: "POST",
    path: "/sync",
    input: {
      services: [
        { name: "web", commandArgv: ["node", "server.js"], advanced: { pid: "service:db" } },
      ],
    },
    result: [service],
    response: { success: true, services: [service] },
  },
  {
    name: "activeContainers",
    method: "GET",
    path: "/containers",
    result: [],
    response: { success: true, containers: [] },
  },
  {
    name: "get",
    child: true,
    method: "GET",
    path: "",
    result: service,
    response: { success: true, service },
  },
  {
    name: "update",
    child: true,
    method: "PATCH",
    path: "",
    input: { environment: { TOKEN: "••••••••", REMOVE: null } },
    result: service,
    response: { success: true, service },
  },
  { name: "remove", child: true, method: "DELETE", path: "", result: { success: true } },
  { name: "applyEnvironment", child: true, method: "POST", path: "/apply-env", result: { success: true, containerId: "new-container" } },
  {
    name: "acceptDrift",
    child: true,
    method: "POST",
    path: "/drift/accept",
    result: service,
    response: { success: true, service },
  },
  {
    name: "keepDrift",
    child: true,
    method: "POST",
    path: "/drift/keep",
    result: service,
    response: { success: true, service },
  },
  {
    name: "listEnvVars",
    child: true,
    method: "GET",
    path: "/env?environment=production",
    input: { environment: "production" },
    result: [],
    response: { success: true, vars: [] },
  },
  {
    name: "setEnvVars",
    child: true,
    method: "PUT",
    path: "/env",
    input: { environment: "production", vars: [] },
    result: { success: true, count: 0 },
  },
  {
    name: "revealEnv",
    child: true,
    method: "POST",
    path: "/env-reveal",
    input: { keys: ["TOKEN"] },
    result: { TOKEN: "only-requested" },
    response: { success: true, environment: { TOKEN: "only-requested" } },
  },
  {
    name: "volumeSizes",
    child: true,
    method: "GET",
    path: "/volume-sizes",
    result: { success: true, measurable: false, totalBytes: null, partial: false, volumes: [] },
  },
  { name: "start", child: true, method: "POST", path: "/start", result: { success: true } },
  { name: "stop", child: true, method: "POST", path: "/stop", result: { success: true } },
  {
    name: "restart",
    child: true,
    method: "POST",
    path: "/restart?force=true",
    input: { force: true },
    body: null,
    result: { success: true, containerId: "container" },
  },
  {
    name: "runtimeLogs",
    child: true,
    method: "GET",
    path: "/logs?tail=30",
    input: { tail: 30 },
    result: [],
    response: { data: [] },
  },
  {
    name: "exec",
    child: true,
    method: "POST",
    path: "/exec",
    input: { command: "node --version" },
    result: { exitCode: 0, output: "v22", truncated: false, timedOut: false, durationMs: 10 },
    response: {
      data: { exitCode: 0, output: "v22", truncated: false, timedOut: false, durationMs: 10 },
    },
  },
];

describe("remote service facade", () => {
  it.each(cases)("adapts $name without changing its native result", async (test) => {
    const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe(
        "https://ship.test/api/projects/project%2Fa/services" +
          (test.child ? "/service%2Fa" : "") +
          test.path,
      );
      expect(init?.method).toBe(test.method);
      if (test.input !== undefined && test.method !== "GET" && test.body !== null)
        expect(JSON.parse(init!.body as string)).toEqual(test.input);
      else expect(init?.body).toBeUndefined();
      return Response.json(test.response ?? test.result);
    });
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    const operation = client.services[test.name] as (...args: unknown[]) => Promise<unknown>;
    expect(
      await operation(
        "project/a",
        ...(test.child ? ["service/a"] : []),
        ...(test.input !== undefined ? [test.input] : []),
      ),
    ).toEqual(test.result);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("rejects invalid secret and exec requests before sending them", async () => {
    const fetcher = vi.fn();
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    await expect(
      client.services.revealEnv("project", "service", { keys: [] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      client.services.exec("project", "service", { command: "id", timeoutMs: 999_999 }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves structured restart refusals and stream cancellation", async () => {
    const failure = {
      success: false,
      code: "SERVICE_CONFIG_STALE",
      error: "Config changed",
      staleEnvKeys: ["TOKEN"],
      serviceName: "web",
    };
    const client = new OpenshipClient({
      baseUrl: "https://ship.test",
      fetch: async () => Response.json(failure, { status: 409 }),
    });
    await expect(client.services.restart("project", "service")).rejects.toMatchObject({
      code: "SERVICE_CONFIG_STALE",
      details: { staleEnvKeys: ["TOKEN"] },
    });
    const abort = new AbortController();
    abort.abort();
    const iterator = client.services
      .streamLogs("project", "service", {}, { signal: abort.signal })
      [Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
  });
  it("passes the viewed deployment identity to the runtime stream", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request) => new Response('event: end\ndata: {}\n\n', { headers: { "content-type": "text/event-stream" } }));
    const client = new OpenshipClient({ baseUrl: "https://ship.test", fetch: fetcher });
    for await (const _event of client.services.streamLogs("project", "service", { tail: 100, deploymentId: "dep/viewed" })) { /* drain */ }
    const url = new URL(String(fetcher.mock.calls[0]![0]));
    expect(url.searchParams.get("deploymentId")).toBe("dep/viewed");
    expect(url.searchParams.get("tail")).toBe("100");
  });
});
