import { describe, it, expect } from "vitest";
import {
  specContainerPort,
  withLoopbackPublish,
  withLoopbackPublishAll,
  upstreamHostPortFor,
} from "../../src/lib/loopback-publish";

describe("a service with SEVERAL routes gets one host port per routed port", () => {
  // Regression: minio routes 9001 (console) and 9000 (s3 API). Pinning only the
  // first route's port and then reusing that single host port for every route made
  // the `s3` subdomain serve the console.
  const pinned = new Map([
    [9001, 20500],
    [9000, 20501],
  ]);

  it("publishes a DISTINCT loopback binding per routed container port", () => {
    expect(withLoopbackPublishAll([], pinned)).toEqual([
      "127.0.0.1:20500:9001",
      "127.0.0.1:20501:9000",
    ]);
  });

  it("replaces a template's own binding for each routed port and keeps the rest", () => {
    const out = withLoopbackPublishAll(["9000:9000", "9001:9001", "1234:1234"], pinned);
    expect(out).toContain("127.0.0.1:20500:9001");
    expect(out).toContain("127.0.0.1:20501:9000");
    expect(out).toContain("1234:1234");
    expect(out.filter((s) => s.endsWith(":9000"))).toHaveLength(1);
    expect(out.filter((s) => s.endsWith(":9001"))).toHaveLength(1);
  });

  it("resolves each route to ITS OWN host port, never the primary's", () => {
    expect(upstreamHostPortFor({ port: 9001, pinned, primaryPort: 9001, sameService: true })).toBe(
      20500,
    );
    expect(upstreamHostPortFor({ port: 9000, pinned, primaryPort: 9001, sameService: true })).toBe(
      20501,
    );
  });

  it("never lends the daemon's single reported port to a SECONDARY route", () => {
    const only = new Map<number, number>();
    // The primary may fall back to what the deploy reported...
    expect(
      upstreamHostPortFor({
        port: 9001,
        pinned: only,
        primaryPort: 9001,
        resultHostPort: 33333,
        sameService: true,
      }),
    ).toBe(33333);
    // ...but a secondary port must resolve to nothing, so the caller uses
    // container-IP addressing rather than proxying to the wrong service.
    expect(
      upstreamHostPortFor({
        port: 9000,
        pinned: only,
        primaryPort: 9001,
        resultHostPort: 33333,
        sameService: true,
      }),
    ).toBeUndefined();
  });

  it("ignores a reported port from a DIFFERENT container", () => {
    expect(
      upstreamHostPortFor({
        port: 9001,
        pinned: new Map(),
        primaryPort: 9001,
        resultHostPort: 33333,
        sameService: false,
      }),
    ).toBeUndefined();
  });
});

describe("specContainerPort", () => {
  it("parses every docker port-spec form", () => {
    expect(specContainerPort("3000")).toBe(3000);
    expect(specContainerPort("8080:3000")).toBe(3000);
    expect(specContainerPort("127.0.0.1:8080:80")).toBe(80);
    expect(specContainerPort("3000/udp")).toBe(3000);
    expect(specContainerPort("0.0.0.0:9090:9000/tcp")).toBe(9000);
    expect(specContainerPort("bogus")).toBeNull();
  });
});

describe("withLoopbackPublish", () => {
  it("republishes an existing 0.0.0.0 binding for the routed port on loopback", () => {
    expect(withLoopbackPublish(["3000:3000"], 3000, 20500)).toEqual(["127.0.0.1:20500:3000"]);
  });

  it("adds a loopback binding when the routed port wasn't published (edge-only service)", () => {
    expect(withLoopbackPublish([], 8080, 20600)).toEqual(["127.0.0.1:20600:8080"]);
  });

  it("leaves OTHER (port-only) bindings untouched", () => {
    expect(withLoopbackPublish(["9000:9000", "3000:3000"], 3000, 21000)).toEqual([
      "9000:9000",
      "127.0.0.1:21000:3000",
    ]);
  });

  it("replaces a differently-mapped host port for the routed container port", () => {
    expect(withLoopbackPublish(["8080:3000"], 3000, 21001)).toEqual(["127.0.0.1:21001:3000"]);
  });
});
