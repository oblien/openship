import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_getResponseFromNextConfig } from "next/experimental/testing/server";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function config(apiProxy: boolean) {
  vi.stubEnv("NEXT_PUBLIC_API_PROXY", String(apiProxy));
  vi.resetModules();
  return (await import("../../next.config.mjs")).default;
}

describe.each([false, true])("GitHub OAuth navigation (API proxy: %s)", (apiProxy) => {
  it.each(["", "?install_state=one%2Btwo%26three&returnTo=%2Fsettings%3Ftab%3Dgit"])(
    "routes the exact authorization endpoint and preserves query values: %s",
    async (query) => {
      const url = new URL(`https://ops.example.com/api/github/connect/redirect${query}`);
      const response = await unstable_getResponseFromNextConfig({
        url: url.href,
        nextConfig: await config(apiProxy),
      });
      const destination = response.headers.get("x-middleware-rewrite");
      if (!apiProxy) {
        expect(destination).toBeNull();
        return;
      }
      expect(destination).not.toBeNull();
      const rewritten = new URL(destination!);
      expect(rewritten.origin).toBe(url.origin);
      expect(rewritten.pathname).toBe("/api/proxy/api/github/connect/redirect");
      expect([...rewritten.searchParams]).toEqual([...url.searchParams]);
    },
  );

  it("does not expose other GitHub endpoints or match descendants", async () => {
    const nextConfig = await config(apiProxy);
    for (const path of [
      "/api/github/connect",
      "/api/github/connect/redirect/extra",
      "/api/github/sources",
    ]) {
      const response = await unstable_getResponseFromNextConfig({
        url: `https://ops.example.com${path}`,
        nextConfig,
      });
      expect(response.headers.get("x-middleware-rewrite"), path).toBeNull();
    }
  });
});

async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

it.each([true, false])(
  "forwards through the existing proxy to a real HTTP upstream (session: %s)",
  async (authenticated) => {
    const requests: { url?: string; cookie?: string; host?: string }[] = [];
    const cookies = [
      "oauth_state=fixture; Path=/; HttpOnly; SameSite=Lax",
      "oauth_binding=fixture; Path=/; Expires=Wed, 21 Oct 2037 07:28:00 GMT; HttpOnly; SameSite=Lax",
    ];
    const location = "https://github.com/login/oauth/authorize?state=fixture";
    const upstream = createServer((request, response) => {
      requests.push({
        url: request.url,
        cookie: request.headers.cookie,
        host: request.headers["x-forwarded-host"] as string,
      });
      if (!request.headers.cookie) {
        response.writeHead(401, { "X-Request-ID": "api-unauthenticated" }).end();
        return;
      }
      response
        .writeHead(302, { Location: location, "Set-Cookie": cookies, "X-Request-ID": "api-oauth" })
        .end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    try {
      const address = upstream.address();
      if (!address || typeof address === "string") throw new Error("Missing test upstream address");
      vi.stubEnv("INTERNAL_API_URL", `http://127.0.0.1:${address.port}`);
      const url =
        "https://ops.example.com/api/github/connect/redirect?install_state=one%2Btwo%26three";
      const routing = await unstable_getResponseFromNextConfig({
        url,
        nextConfig: await config(true),
      });
      const destination = routing.headers.get("x-middleware-rewrite");
      expect(destination).not.toBeNull();
      const path = new URL(destination!).pathname.slice("/api/proxy/".length).split("/");
      const { GET } = await import("../app/api/proxy/[...path]/route");
      const session = "better-auth.session_token=fixture";
      const response = await GET(
        new NextRequest(url, { headers: authenticated ? { cookie: session } : {} }),
        {
          params: Promise.resolve({ path }),
        },
      );
      expect(requests).toEqual([
        {
          url: "/api/github/connect/redirect?install_state=one%2Btwo%26three",
          cookie: authenticated ? session : undefined,
          host: "ops.example.com",
        },
      ]);
      expect(response.status).toBe(authenticated ? 302 : 401);
      expect(response.headers.get("location")).toBe(authenticated ? location : null);
      expect(response.headers.getSetCookie()).toEqual(authenticated ? cookies : []);
    } finally {
      await close(upstream);
    }
  },
);
