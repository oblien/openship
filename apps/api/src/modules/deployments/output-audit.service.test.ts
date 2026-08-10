import { describe, expect, it, vi } from "vitest";
import { auditStaticOutput, staticOutputTargets } from "./output-audit.service";
import type { BuildLogger } from "@repo/adapters";

const logger = { log: vi.fn() } as unknown as BuildLogger;

describe("staticOutputTargets", () => {
  const ROOT = "/opt/openship/static/dep_1";

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

    expect(routing.probeStaticRoot).toHaveBeenCalledWith("/opt/openship/static/dep_1");
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
