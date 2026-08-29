import { describe, expect, it, vi } from "vitest";
import {
  auditStaticOutput,
  outputFindingIsBroken,
  staticOutputTargets,
} from "./output-audit.service";
import type { BuildLogger } from "@repo/adapters";

const logger = { log: vi.fn() } as unknown as BuildLogger;
const ROOT = "/opt/openship/static/dep_1";

describe("staticOutputTargets", () => {

  it("maps routed paths under the doc-root and dedupes", () => {
    expect(
      staticOutputTargets(ROOT, [
        { targetPath: "/" },
        { targetPath: "/docs" },
        { targetPath: "/docs" },
      ]),
    ).toEqual([
      { path: "/", servedPath: ROOT },
      { path: "/docs", servedPath: `${ROOT}/docs` },
    ]);
  });

  it("falls back to the root when nothing is routed yet", () => {
    // There is still exactly one thing worth checking — the doc-root itself.
    expect(staticOutputTargets(ROOT, [])).toEqual([{ path: "/", servedPath: ROOT }]);
  });
});

describe("auditStaticOutput vantage point", () => {
  const targets = [{ path: "/", servedPath: "/opt/openship/static/dep_1" }];

  it("prefers the ROUTING provider — it sees what the proxy sees", async () => {
    // This is the whole point of the audit. For a containerized edge the vhost
    // `root` is a host path that must be bind-mounted in; the host says the files
    // are there while nginx sees an empty dir and 404s. Only the edge's answer
    // predicts the 404, so a runtime that disagrees must NOT win.
    const routing = {
      registerRoute: vi.fn(),
      removeRoute: vi.fn(),
      probeStaticRoot: vi.fn(async () => ({ found: false, hasIndex: false, checked: true })),
    };
    const runtime = {
      inContainerExecutor: vi.fn(async () => ({ exec: async () => "FOUND\nINDEX\n" })),
    };

    const res = await auditStaticOutput(
      { routing: routing as never, runtime: runtime as never, containerId: "c1" },
      targets,
      logger,
    );

    expect(routing.probeStaticRoot).toHaveBeenCalledWith("/opt/openship/static/dep_1", {
      hostname: undefined,
      requestPath: "/",
    });
    expect(runtime.inContainerExecutor).not.toHaveBeenCalled();
    expect(res[0]).toMatchObject({ found: false, checked: true });
  });

  it("falls back to the runtime when the provider serves no files (cloud/noop)", async () => {
    const routing = { registerRoute: vi.fn(), removeRoute: vi.fn() }; // no probeStaticRoot
    const runtime = {
      inContainerExecutor: vi.fn(async () => ({ exec: async () => "FOUND\nINDEX\n" })),
    };

    const res = await auditStaticOutput(
      { routing: routing as never, runtime: runtime as never, containerId: "c1" },
      targets,
      logger,
    );

    expect(runtime.inContainerExecutor).toHaveBeenCalled();
    expect(res[0]).toMatchObject({ found: true, hasIndex: true, checked: true });
  });

  it("reports inconclusive — never 'missing' — when nothing can probe", async () => {
    // checked:false must never be rendered as a problem: no signal is not bad news.
    const res = await auditStaticOutput({ routing: null, runtime: null }, targets, logger);
    expect(res[0]).toMatchObject({ checked: false, found: false, skippedReason: "no-exec" });
  });

  it("keeps readings for other targets when one probe throws", async () => {
    const routing = {
      registerRoute: vi.fn(),
      removeRoute: vi.fn(),
      probeStaticRoot: vi.fn(async (p: string) => {
        if (p.endsWith("/bad")) throw new Error("boom");
        return { found: true, hasIndex: true, checked: true };
      }),
    };
    const res = await auditStaticOutput(
      { routing: routing as never },
      [
        { path: "/", servedPath: "/root" },
        { path: "/bad", servedPath: "/root/bad" },
      ],
      logger,
    );

    expect(res).toHaveLength(2);
    expect(res[0]).toMatchObject({ found: true, checked: true });
    expect(res[1]).toMatchObject({ checked: false, skippedReason: "no-exec" });
  });

  it("warns specifically when the root exists but has no index", async () => {
    // The most common static 404: doc-root present (so deploy-time validation
    // passed) with the real index one level deeper.
    const log = vi.fn();
    const routing = {
      registerRoute: vi.fn(),
      removeRoute: vi.fn(),
      probeStaticRoot: vi.fn(async () => ({ found: true, hasIndex: false, checked: true })),
    };
    await auditStaticOutput({ routing: routing as never }, targets, {
      log,
    } as unknown as BuildLogger);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("no index.html"), "warn");
  });
});

describe("staticOutputTargets hostname", () => {
  it("carries the endpoint hostname so the HTTP half can ask as it", () => {
    const [target] = staticOutputTargets(ROOT, [
      { targetPath: "/", hostname: "example.com", isPrimary: true },
    ]);
    expect(target).toMatchObject({ path: "/", hostname: "example.com" });
  });

  it("keeps ONE target per routed path, preferring the primary hostname", () => {
    // Cardinality is load-bearing: `meta.outputCheck`'s length and the dashboard's
    // `c.path === targetPath` matcher both assume one entry per path. An alias must
    // not add a second probe of the same directory — it may only upgrade the host
    // the probe asks as.
    const targets = staticOutputTargets(ROOT, [
      { targetPath: "/", hostname: "alias.example.com", isPrimary: false },
      { targetPath: "/", hostname: "example.com", isPrimary: true },
    ]);
    expect(targets).toHaveLength(1);
    expect(targets[0]!.hostname).toBe("example.com");
  });

  it("omits hostname when no endpoint has one — HTTP half is then skipped", () => {
    expect(staticOutputTargets(ROOT, [{ targetPath: "/" }])[0]).not.toHaveProperty("hostname");
  });
});

describe("outputFindingIsBroken precedence", () => {
  const base = { path: "/", servedPath: ROOT, found: true, hasIndex: true, checked: true };

  it("never calls an inconclusive probe broken", () => {
    // The invariant the whole audit rests on: a probe that could not RUN must not
    // be readable as a failure.
    for (const over of [
      { found: false },
      { hasIndex: false },
      { served: false, status: 404 },
    ]) {
      expect(outputFindingIsBroken({ ...base, ...over, checked: false })).toBe(false);
    }
  });

  it("treats a proven 404/5xx from the edge as broken", () => {
    expect(outputFindingIsBroken({ ...base, served: false, status: 404 })).toBe(true);
    expect(outputFindingIsBroken({ ...base, served: false, status: 502 })).toBe(true);
  });

  it("lets a serving edge OVERRIDE a missing index.html", () => {
    // With `cleanUrls`, `try_files $uri.html` resolves /about from about.html and
    // no index.html need exist. The filesystem rule alone reported a phantom
    // failure — and, with an opt-in gate set to "fail", vetoed a working deploy.
    expect(outputFindingIsBroken({ ...base, hasIndex: false, served: true })).toBe(false);
    // Explicitly for a 2xx, since the override is now status-aware.
    expect(outputFindingIsBroken({ ...base, hasIndex: false, served: true, status: 200 })).toBe(
      false,
    );
  });

  it("does NOT let a REDIRECT override a missing index.html", () => {
    // The blocker. On a route with a certificate the :80 block opens with the
    // HTTP→HTTPS upgrade, which `return 301`s BEFORE the doc root is consulted —
    // and `statusIsServed` maps 3xx to served. So the one detector for "the root
    // exists but nothing servable is in it" was overridden by a redirect that had
    // never looked at the root, and a wrong Output Directory deployed green and
    // 404'd every visitor. This is the common case, not an edge one: Angular is
    // detected with `dist` while Angular 17+ emits dist/<app>/browser.
    for (const status of [301, 302, 307, 308]) {
      expect(
        outputFindingIsBroken({ ...base, hasIndex: false, served: true, status }),
        String(status),
      ).toBe(true);
    }
  });

  it("still trusts a policy answer (401/403) over a missing index", () => {
    // Only 3xx loses the override. A 401/403 means a policy answered a route that
    // RESOLVED — basic auth, an edge rules guard — and with cleanUrls there is
    // legitimately no index.html behind it, so reporting those broken would be a
    // false alarm on a site behaving exactly as configured.
    expect(outputFindingIsBroken({ ...base, hasIndex: false, served: true, status: 401 })).toBe(
      false,
    );
    expect(outputFindingIsBroken({ ...base, hasIndex: false, served: true, status: 403 })).toBe(
      false,
    );
  });

  it("falls back to the filesystem rule when there is no HTTP signal", () => {
    // Every record written before the HTTP half existed has `served: undefined`;
    // those must read exactly as they did before.
    expect(outputFindingIsBroken({ ...base, hasIndex: false })).toBe(true);
    expect(outputFindingIsBroken({ ...base, found: false, hasIndex: false })).toBe(true);
    expect(outputFindingIsBroken(base)).toBe(false);
  });
});

describe("auditStaticOutput HTTP half", () => {
  const targets = [
    { path: "/", servedPath: ROOT, hostname: "example.com" },
  ];

  const routingWith = (result: Record<string, unknown>) => ({
    registerRoute: vi.fn(),
    removeRoute: vi.fn(),
    probeStaticRoot: vi.fn(async () => result),
  });

  it("passes the hostname and routed path down to the probe", async () => {
    const routing = routingWith({ found: true, hasIndex: true, checked: true });
    await auditStaticOutput({ routing: routing as never }, targets, logger);
    expect(routing.probeStaticRoot).toHaveBeenCalledWith(ROOT, {
      hostname: "example.com",
      requestPath: "/",
    });
  });

  it("carries status/served onto the result", async () => {
    const routing = routingWith({
      found: true,
      hasIndex: true,
      checked: true,
      status: 404,
      served: false,
    });
    const [res] = await auditStaticOutput({ routing: routing as never }, targets, logger);
    expect(res).toMatchObject({ status: 404, served: false });
  });

  it("OMITS status/served entirely when there was no HTTP signal", async () => {
    // Absent, not `false` — a reader testing `!served` would otherwise report every
    // filesystem-only reading as broken.
    const routing = routingWith({ found: true, hasIndex: true, checked: true });
    const [res] = await auditStaticOutput({ routing: routing as never }, targets, logger);
    expect(res).not.toHaveProperty("served");
    expect(res).not.toHaveProperty("status");
  });

  it("warns about the edge's status when it answered an error", async () => {
    const log = vi.fn();
    const routing = routingWith({
      found: true,
      hasIndex: true,
      checked: true,
      status: 502,
      served: false,
    });
    await auditStaticOutput({ routing: routing as never }, targets, {
      log,
    } as unknown as BuildLogger);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("HTTP 502"), "warn");
  });

  it("stays SILENT when the edge proves it serves despite no index.html", async () => {
    const log = vi.fn();
    const routing = routingWith({
      found: true,
      hasIndex: false,
      checked: true,
      status: 200,
      served: true,
    });
    await auditStaticOutput({ routing: routing as never }, targets, {
      log,
    } as unknown as BuildLogger);
    expect(log).not.toHaveBeenCalled();
  });
});
