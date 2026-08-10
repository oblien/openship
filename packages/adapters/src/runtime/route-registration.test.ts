import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerResolvedRoutes, type RoutedDomainInput } from "./route-registration";
import { explainEdgeDown } from "../system/edge-exec-error";

const logger = { log: vi.fn(), step: vi.fn() } as any;
const routeTarget = { targetUrl: "http://127.0.0.1:12345" };
const domain = (hostname: string): RoutedDomainInput => ({ hostname, tls: false, targetPort: 3000 });

const RESTARTING =
  "Error response from daemon: Container abc123 is restarting, wait until the container is running";

// What the edge executor actually throws when the edge is crash-looping: the
// enriched one-line explanation joined to the daemon's own "is restarting" line.
// The daemon phrase riding along is exactly why isContainerRestartingError used to
// false-positive on this and burn four pointless retries.
const EDGE_DOWN_BLOB = `${explainEdgeDown({
  container: "openship-edge",
  status: "restarting",
  reason: "[emerg] bind() to 0.0.0.0:80 failed (98: Address in use)",
})}\n${RESTARTING}`;

describe("registerResolvedRoutes — transient container-restart handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Neutralize the retry backoff so the test doesn't actually wait.
    vi.stubGlobal("setTimeout", ((fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("retries 'container is restarting' and records NO warning once it settles", async () => {
    let calls = 0;
    const routing = {
      registerRoute: vi.fn(async () => {
        calls++;
        if (calls < 3) throw new Error(RESTARTING);
      }),
    } as any;

    const warnings = await registerResolvedRoutes(
      logger,
      routing,
      undefined,
      [domain("app.example.com")],
      routeTarget,
    );

    expect(warnings).toEqual([]);
    expect(routing.registerRoute).toHaveBeenCalledTimes(3);
  });

  it("records a warning only after exhausting retries when it never settles", async () => {
    const routing = {
      registerRoute: vi.fn(async () => {
        throw new Error(RESTARTING);
      }),
    } as any;

    const warnings = await registerResolvedRoutes(
      logger,
      routing,
      undefined,
      [domain("app.example.com")],
      routeTarget,
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("app.example.com");
    expect(warnings[0]).toContain("is restarting");
    expect(routing.registerRoute).toHaveBeenCalledTimes(5); // ROUTE_MAX_ATTEMPTS
  });

  it("does NOT retry a non-transient routing error — records it immediately", async () => {
    const routing = {
      registerRoute: vi.fn(async () => {
        throw new Error("nginx reload failed");
      }),
    } as any;

    const warnings = await registerResolvedRoutes(
      logger,
      routing,
      undefined,
      [domain("app.example.com")],
      routeTarget,
    );

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("nginx reload failed");
    expect(routing.registerRoute).toHaveBeenCalledTimes(1); // no wasted retries on a real failure
  });

  // Bug: a crash-looping EDGE was mislabeled "target container is still starting up"
  // and retried 4× — wrong on both counts. The edge never self-heals by our waiting,
  // and for a static app (no container of its own) the message is nonsensical.
  it("does NOT retry when the EDGE is down — records it on the first attempt", async () => {
    const routing = {
      registerRoute: vi.fn(async () => {
        throw new Error(EDGE_DOWN_BLOB);
      }),
    } as any;

    const warnings = await registerResolvedRoutes(
      logger,
      routing,
      undefined,
      [domain("chartsv.opsh.io")],
      routeTarget,
    );

    expect(routing.registerRoute).toHaveBeenCalledTimes(1); // no wasted retries into a dead edge
    expect(warnings).toHaveLength(1);
    // Surfaces the operator-facing explanation, not the raw daemon blob…
    expect(warnings[0]).toContain("the edge container is not running");
    // …and never the misleading app-container / DNS advice.
    const logged = logger.log.mock.calls.map((c: unknown[]) => String(c[0])).join("");
    expect(logged).not.toContain("target container is still starting up");
    expect(logged).not.toContain("fix DNS/routing");
  });

  it("registers cleanly on the first attempt with no warning", async () => {
    const routing = { registerRoute: vi.fn(async () => {}) } as any;

    const warnings = await registerResolvedRoutes(
      logger,
      routing,
      undefined,
      [domain("app.example.com")],
      routeTarget,
    );

    expect(warnings).toEqual([]);
    expect(routing.registerRoute).toHaveBeenCalledTimes(1);
  });
});

/**
 * Reverse-proxy tunables are a property of the PROJECT, not of any one upstream, so
 * they arrive as a registration option and land on every domain's vhost. Threading
 * them through `resolveRoute`/`resolveTargetUrl` instead would make each of those
 * re-answer a question the project already answered — and let a static route and a
 * proxied one in the same project disagree about the upload limit.
 */
describe("registerResolvedRoutes — proxy tunables", () => {
  const PROXY_OPTS = { clientMaxBodySize: "50m", proxyReadTimeout: "300s" };

  it("applies the options' proxy settings to EVERY domain", async () => {
    const routing = { registerRoute: vi.fn(async () => {}) } as any;

    await registerResolvedRoutes(
      logger,
      routing,
      undefined,
      [domain("a.example.com"), domain("b.example.com")],
      routeTarget,
      undefined,
      { proxy: PROXY_OPTS },
    );

    expect(routing.registerRoute).toHaveBeenCalledTimes(2);
    for (const call of routing.registerRoute.mock.calls) {
      expect(call[0].proxy).toEqual(PROXY_OPTS);
    }
  });

  it("omits `proxy` entirely when none is configured, so nginx defaults apply", async () => {
    const routing = { registerRoute: vi.fn(async () => {}) } as any;

    await registerResolvedRoutes(logger, routing, undefined, [domain("a.example.com")], routeTarget);

    expect(routing.registerRoute.mock.calls[0][0].proxy).toBeUndefined();
  });

  it("applies them to a STATIC route too", async () => {
    // client_max_body_size and the body timeouts govern reading the REQUEST, which
    // nginx does before it decides whether a file or an upstream answers.
    const routing = { registerRoute: vi.fn(async () => {}) } as any;

    await registerResolvedRoutes(
      logger,
      routing,
      undefined,
      [{ hostname: "site.example.com", tls: false, targetPath: "/" }],
      { staticRoot: "/opt/openship/static/site" },
      undefined,
      { proxy: PROXY_OPTS },
    );

    expect(routing.registerRoute.mock.calls[0][0]).toMatchObject({
      staticRoot: "/opt/openship/static/site",
      proxy: PROXY_OPTS,
    });
  });
});
