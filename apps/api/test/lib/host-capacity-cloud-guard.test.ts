import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Host-capacity probing is SELF-HOSTED ONLY.
 *
 * It opens a Docker daemon connection to a server — over the pooled SSH bridge
 * for a remote box. On a multi-tenant cloud (CLOUD_MODE) control plane that is
 * both pointless (an Oblien workspace is sized from the tier table, not from
 * host hardware) and something we never want reachable from a tenant-facing
 * route. The module must therefore short-circuit on CLOUD_MODE *before* it can
 * reach `createServerDockerRuntime`.
 *
 * Asserted structurally rather than by calling the function: importing
 * host-capacity.ts pulls in the SSH manager and the whole deployment-runtime
 * graph, and a behavioral test would have to mock enough of it that it would
 * stop proving anything about the real import order.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("host-capacity is self-hosted only", () => {
  const src = read("../../src/lib/host-capacity.ts");

  it("gates on CLOUD_MODE inside the exported entry point", () => {
    expect(src).toContain("env.CLOUD_MODE");
    const fnStart = src.indexOf("export async function getHostCapacity");
    expect(fnStart, "getHostCapacity not found").toBeGreaterThan(-1);
    const guardAt = src.indexOf("env.CLOUD_MODE", fnStart);
    expect(guardAt, "CLOUD_MODE guard is not inside getHostCapacity").toBeGreaterThan(fnStart);
  });

  it("returns before any probe when CLOUD_MODE is set", () => {
    const fnStart = src.indexOf("export async function getHostCapacity");
    const guardAt = src.indexOf("env.CLOUD_MODE", fnStart);
    // The guard must precede every path that could open a connection: the probe
    // helper AND the cache read that gates it.
    const probeAt = src.indexOf("probe(", guardAt);
    const storeAt = src.indexOf("cacheStore<HostCapacity>", guardAt);
    expect(probeAt).toBeGreaterThan(guardAt);
    expect(storeAt).toBeGreaterThan(guardAt);
    // …and it must be an early return, not a branch that falls through.
    const guardLine = src.slice(guardAt, src.indexOf("\n", guardAt) + 200);
    expect(guardLine).toMatch(/return\s*\{\s*\.\.\.UNKNOWN_CAPACITY\s*\}/);
  });

  it("never builds a shell command — no exec/interpolation surface", () => {
    // `docker info` is an HTTP call on the daemon socket. If this module ever
    // starts shelling out with a caller-supplied serverId, that's a new
    // injection surface and this test should fail until it's reviewed.
    expect(src).not.toMatch(/\.exec\(/);
    expect(src).not.toMatch(/execSync|spawn\(/);
  });

  it("disposes the runtime so a remote SSH bridge can't leak", () => {
    expect(src).toContain("runtime?.dispose");
  });
});

/**
 * The resources endpoint must not probe for a cloud project either — that path
 * has no SSH target at all, and reaching for one would surface as a hang.
 */
describe("project resources capacity resolution", () => {
  const src = read("../../src/modules/projects/project-resources.service.ts");

  it("skips the probe entirely for a cloud project", () => {
    const fnStart = src.indexOf("async function resolveTargetCapacity");
    expect(fnStart).toBeGreaterThan(-1);
    const body = src.slice(fnStart, src.indexOf("\n}", fnStart));
    const earlyReturn = body.indexOf("if (isCloud) return");
    const probeCall = body.indexOf("getHostCapacity");
    expect(earlyReturn, "no isCloud early return").toBeGreaterThan(-1);
    expect(probeCall).toBeGreaterThan(earlyReturn);
  });

  it("requires an explicit limit on cloud and allows unlimited self-hosted", () => {
    expect(src).toContain("requireLimit: isCloud");
  });
});
