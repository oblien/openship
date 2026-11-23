import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { errorReporter, consoleErrorSink, type ErrorEvent } from "@repo/core/diagnostics";

import { GET, POST } from "./route";

const upstreamFetch = vi.fn<typeof fetch>();
const events: ErrorEvent[] = [];

beforeEach(async () => {
  await errorReporter.flush();
  events.length = 0;
  errorReporter.setEnabled(true);
  errorReporter.setSink(batch => { events.push(...batch); });
  vi.stubEnv("NEXT_PUBLIC_API_PROXY", "true");
  vi.stubEnv("INTERNAL_API_URL", "http://api:4000");
  vi.stubGlobal("fetch", upstreamFetch);
  upstreamFetch.mockResolvedValue(new Response(null, { status: 401 }));
});

afterEach(async () => {
  await errorReporter.flush();
  errorReporter.setEnabled(false);
  errorReporter.setSink(consoleErrorSink);
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  upstreamFetch.mockReset();
});

it("streams folder uploads larger than the middleware default without changing their bytes", async () => {
  const bytes = new Uint8Array(12 * 1024 * 1024).fill(117);
  upstreamFetch.mockImplementationOnce(async (_url, init) => {
    const received = new Uint8Array(await new Response(init?.body).arrayBuffer());
    expect(createHash("sha256").update(received).digest("hex")).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer upload-test");
    return Response.json({ received: received.length });
  });
  const response = await POST(new NextRequest("https://ops.example.com/api/proxy/api/projects/folder/upload/session", {
    method: "POST", headers: { authorization: "Bearer upload-test", "Content-Type": "application/gzip" }, body: bytes,
  }), { params: Promise.resolve({ path: ["api", "projects", "folder", "upload", "session"] }) });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ received: bytes.length });
});

it("correlates proxy network failures without logging credentials or request contents", async () => {
  upstreamFetch.mockRejectedValueOnce(Object.assign(new Error("Connection refused"), {
    code: "ECONNREFUSED", headers: { authorization: "private-proxy-token-913" },
  }));
  const response = await GET(new NextRequest("https://ops.example.com/api/proxy/api/projects?token=private-proxy-token-913"), {
    params: Promise.resolve({ path: ["api", "projects"] }),
  });
  expect(response.status).toBe(502);
  const requestId = response.headers.get("X-Request-ID");
  expect(requestId).toBeTruthy();
  expect(new Headers(upstreamFetch.mock.calls[0]![1]?.headers).get("X-Request-ID")).toBe(requestId);
  await errorReporter.flush();
  expect(events[0]).toMatchObject({ context: { requestId, statusCode: 502 } });
  expect(JSON.stringify(events)).not.toContain("private-proxy-token-913");
});

it("preserves the API's own response reference and does not duplicate its recorded failure", async () => {
  upstreamFetch.mockResolvedValueOnce(new Response(null, { status: 403, headers: { "X-Request-ID": "api-reference" } }));
  const response = await GET(new NextRequest("https://ops.example.com/api/proxy/api/projects"), {
    params: Promise.resolve({ path: ["api", "projects"] }),
  });
  expect(response.headers.get("X-Request-ID")).toBe("api-reference");
  await errorReporter.flush();
  expect(events).toHaveLength(0);
});

describe("MCP through the dashboard API proxy", () => {
  it.each([
    ["GET", "/api/mcp"],
    ["POST", "/api/mcp"],
    ["GET", "/api/proxy/api/mcp"],
    ["POST", "/api/proxy/api/mcp"],
  ])("preserves the public path for %s %s", async (method, path) => {
    // Next's /api/mcp rewrite selects this handler with the same params as an
    // explicit /api/proxy/api/mcp request, but req.url retains the public URL.
    const request = new NextRequest(`https://ops.example.com${path}?client=desktop`, {
      method,
      headers: { "x-forwarded-uri": "/attacker-supplied-path" },
    });
    const handler = method === "GET" ? GET : POST;

    const response = await handler(request, { params: Promise.resolve({ path: ["api", "mcp"] }) });

    expect(response.status).toBe(401);
    expect(upstreamFetch).toHaveBeenCalledOnce();
    const [url, init] = upstreamFetch.mock.calls[0]!;
    expect(String(url)).toBe("http://api:4000/api/mcp?client=desktop");
    expect(init?.method).toBe(method);
    const headers = new Headers(init?.headers);
    expect(headers.get("x-forwarded-uri")).toBe(path);
    expect(headers.get("x-forwarded-host")).toBe("ops.example.com");
    expect(headers.get("x-forwarded-proto")).toBe("https");
  });
});
