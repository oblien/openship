import { afterEach, describe, expect, it, vi } from "vitest";

import { alignLoopbackOrigin, resolveApiNavigationUrl } from "./urls";

describe("external MCP endpoint", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("advertises the canonical OAuth resource on a self-hosted proxy dashboard", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_PROXY", "true");
    vi.stubGlobal("window", { location: { origin: "https://ops.example.com" } });
    vi.resetModules();
    const urls = await import("./urls");
    expect(urls.getRestApiBaseUrl()).toBe("https://ops.example.com/api/proxy/api");
    expect(urls.getMcpEndpointUrl()).toBe("https://ops.example.com/api/mcp");
  });

  it("keeps the actual dynamic API port for a desktop installation", async () => {
    vi.stubEnv("NEXT_PUBLIC_API_PROXY", "false");
    vi.stubGlobal("window", {
      location: { origin: "http://localhost:41001" },
      __OPENSHIP_API_ORIGIN__: "http://127.0.0.1:42002",
    });
    vi.resetModules();
    const urls = await import("./urls");
    expect(urls.getMcpEndpointUrl()).toBe("http://localhost:42002/api/mcp");
  });
});

describe("alignLoopbackOrigin", () => {
  it("rewrites a 127.0.0.1 API origin when the page is served from localhost", () => {
    // The bug in #27: dashboard on localhost:3001, API injected as 127.0.0.1:4000.
    // Cross-site for the browser, so the session cookie is dropped.
    expect(alignLoopbackOrigin("http://127.0.0.1:4000", "http://localhost:3001")).toBe(
      "http://localhost:4000",
    );
  });

  it("rewrites the other way round too", () => {
    expect(alignLoopbackOrigin("http://localhost:4000", "http://127.0.0.1:3001")).toBe(
      "http://127.0.0.1:4000",
    );
  });

  it("leaves the origin alone when hosts already match", () => {
    expect(alignLoopbackOrigin("http://localhost:4000", "http://localhost:3001")).toBe(
      "http://localhost:4000",
    );
  });

  it("does not touch non-loopback origins", () => {
    expect(alignLoopbackOrigin("https://api.example.com", "http://localhost:3001")).toBe(
      "https://api.example.com",
    );
    expect(alignLoopbackOrigin("http://127.0.0.1:4000", "https://app.example.com")).toBe(
      "http://127.0.0.1:4000",
    );
  });

  it("passes a malformed override through unchanged", () => {
    expect(alignLoopbackOrigin("not a url", "http://localhost:3001")).toBe("not a url");
  });
});

describe("resolveApiNavigationUrl", () => {
  it("maps an API-root redirect through the dashboard proxy mount", () => {
    expect(
      resolveApiNavigationUrl(
        "/api/github/connect/redirect?install_state=nonce",
        "https://app.openship.io/api/proxy/api",
      ),
    ).toBe("https://app.openship.io/api/proxy/api/github/connect/redirect?install_state=nonce");
  });

  it("maps the same redirect to a split API origin", () => {
    expect(
      resolveApiNavigationUrl(
        "/api/github/connect/redirect?install_state=nonce",
        "https://api.openship.io/api",
      ),
    ).toBe("https://api.openship.io/api/github/connect/redirect?install_state=nonce");
  });

  it("accepts an endpoint-registry path without duplicating the API prefix", () => {
    expect(
      resolveApiNavigationUrl("github/connect/redirect", "https://ops.example.com/api/proxy/api/"),
    ).toBe("https://ops.example.com/api/proxy/api/github/connect/redirect");
  });

  it("preserves an absolute GitHub destination", () => {
    expect(
      resolveApiNavigationUrl(
        "https://github.com/apps/openship/installations/new?state=nonce",
        "https://app.openship.io/api/proxy/api",
      ),
    ).toBe("https://github.com/apps/openship/installations/new?state=nonce");
  });

  it("rejects unsafe schemes and relative paths that escape the API mount", () => {
    expect(() =>
      resolveApiNavigationUrl("javascript:alert(1)", "https://api.openship.io/api"),
    ).toThrow();
    expect(() => resolveApiNavigationUrl("../auth", "https://api.openship.io/api")).toThrow();
  });
});
