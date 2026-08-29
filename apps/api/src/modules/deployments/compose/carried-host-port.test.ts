import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { pickHostPort } from "@repo/adapters";

/**
 * A host port cannot travel with a project.
 *
 * The deploy persists the loopback host port it pinned for a service and reuses it on the next
 * deploy, which is right on the SAME host: the port was ours and still is. It is wrong the moment
 * the host changes. A migration replays the source's port on a target that knows nothing about
 * it, and if anything there holds it Docker refuses the bind:
 *
 *   driver failed programming external connectivity on endpoint openship-clincai-api:
 *   Bind for 127.0.0.1:20001 failed: port is already allocated
 *
 * — which took down `api` and, by dependency, `dashboard` and `web`: 3 of 5 services, on a
 * migration whose data had already transferred successfully.
 *
 * The allocator already had the right primitive (`preferred` = keep it if free), so the fix is to
 * route the carried port through it instead of branching around it.
 */
describe("pickHostPort's preferred-port contract", () => {
  it("keeps the carried port when it is free — stable redeploys", () => {
    expect(pickHostPort(new Set(), { preferred: 20001 })).toBe(20001);
  });

  it("picks another when the carried port is occupied on THIS host", () => {
    // The migration case: 20001 came from the source and is taken on the target.
    const port = pickHostPort(new Set([20001]), { preferred: 20001 });
    expect(port).not.toBe(20001);
    expect(port).toBeGreaterThanOrEqual(20000);
  });

  it("picks another when a sibling in the same deploy already took it", () => {
    expect(pickHostPort(new Set(), { preferred: 20001, avoid: [20001] })).not.toBe(20001);
  });

  it("keeps a carried port that predates the current range", () => {
    // Documented behaviour of `preferred`, and worth pinning: a project pinned outside
    // 20000-29999 must not be renumbered just for being old.
    expect(pickHostPort(new Set(), { preferred: 15000 })).toBe(15000);
  });

  it("falls back to the range start when nothing is carried", () => {
    expect(pickHostPort(new Set(), {})).toBe(20000);
  });
});

describe("the deploy routes the carried port through the allocator", () => {
  const src = readFileSync(new URL("./deploy.service.ts", import.meta.url), "utf8");
  /** The loopback-port allocation block, bounded by its own loop. */
  const block = (() => {
    const from = src.indexOf("for (const containerPort of routedContainerPorts) {");
    return src.slice(from, src.indexOf("serviceRuntimeConfig.ports =", from));
  })();

  it("passes the carried port as `preferred`, not as the answer", () => {
    expect(block).toContain("cachedPreferred");
    expect(block).toContain("allocateAndReservePinnedHostPort");
  });

  it("no longer short-circuits the allocator when a carried port exists", () => {
    // The bug in one line: `if (carried) { hostPort = carried; }` — no availability check, on a
    // host that had never seen that port.
    expect(block).not.toMatch(/if \(carried\) \{\s*hostPort = carried;/);
  });

  it("still avoids durable host claims and ports this same deploy already handed out", () => {
    expect(block).toContain("claims: pinnedHostPortClaims");
    expect(block).toContain("allocatedHostPorts");
    expect(block).toContain("additionalAvoid: allocatedHostPorts");
    expect(block).toContain("pinnedHostPortClaims.push(allocation.claim)");
  });

  it("says so when it had to move a carried port", () => {
    // Otherwise a port silently changing between deploys looks like a bug from the outside.
    expect(block).toContain("hostPort !== carried");
    expect(block).toContain("is taken on this server");
  });

  it("keeps the unreadable-occupancy warning, which is a different failure", () => {
    // A scan that could not run is not "nothing is listening" (#490) — with `preferred` set,
    // that case now returns the carried port, so the warning is the only signal.
    expect(block).toContain("allocation.scanned");
  });

  it("migrates/converges the edge before importing its ports into allocation", () => {
    const edgePreflight = src.indexOf("const edge = await ensureEdge(");
    const strictInventory = src.indexOf("await prepareTargetPinnedHostPorts({");

    expect(edgePreflight).toBeGreaterThan(-1);
    expect(strictInventory).toBeGreaterThan(edgePreflight);
    expect(src.slice(edgePreflight, strictInventory)).toContain("ensureRoutingReady");
  });

  it("validates every resolved loopback target under its service owner before routing", () => {
    const resolverStart = src.indexOf("resolveTargetUrl:", src.indexOf("const deployEnv"));
    const resolverEnd = src.indexOf("const deployResult = await runDeployPipeline", resolverStart);
    const resolver = src.slice(resolverStart, resolverEnd);

    expect(resolver).toContain("reserveResolvedLoopbackRoutes");
    expect(resolver).toContain("serviceId: svc.id");
    expect(resolver).toContain("containerPort: port");
  });
});
