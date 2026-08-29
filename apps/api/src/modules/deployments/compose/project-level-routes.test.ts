import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * A compose release's PROJECT-LEVEL domain rows (`domains.service_id IS NULL`) must be
 * planned by the deploy, not only by the live re-apply.
 *
 * This pipeline returns before `executeServerDeploy`, so `buildProjectRouteDomains` —
 * the project-level planner — was simply unreachable from here: for a compose release
 * those rows were planned by NOTHING on deploy, and their vhost existed only if the
 * operator had saved a domain since. That asymmetry is #618's class, not just its
 * reported instance: a route that works after a domain save and is absent from the
 * deploy's own account of itself.
 *
 * Driving `deployComposeServices` needs a runtime, a docker host and a repo layer, so —
 * exactly as `test/lib/proxy-settings-wiring.test.ts` does for the same file — this pins
 * the WIRING as a source contract. The behaviour underneath it is covered against real
 * inputs in `src/lib/project-service-upstream.test.ts`, including the agreement between
 * the deploy's pure resolver and the live one.
 */
const SRC = readFileSync(new URL("./deploy.service.ts", import.meta.url), "utf8");

/**
 * The project-level block itself, delimited by its own anchors rather than a character
 * count — a window sized in characters silently stops covering the block the moment
 * anything is added to it, which is the opposite of what a contract test is for.
 */
const BLOCK = (() => {
  const start = SRC.indexOf("const projectLevelRoutes = buildProjectRouteDomains({");
  const end = SRC.indexOf("Project domain routing skipped", start);
  if (start === -1 || end === -1) throw new Error("project-level route block not found");
  return SRC.slice(start, end);
})();

describe("compose deploy plans project-level domain rows", () => {
  it("reaches the project-level planner the single-app deploy uses", () => {
    // Not a second, parallel planner — the SAME one, so tls / verified gating / SSL
    // cannot drift between the two deploy shapes.
    expect(SRC).toContain("buildProjectRouteDomains({");
  });

  it("resolves the upstream through the shared port-owner resolver", () => {
    expect(SRC).toContain("buildProjectServiceUpstream({");
  });

  it("registers project-level routes BEFORE the composite and the fan-out", () => {
    // `registerRoute` is last-writer-wins per hostname, and both the vercel composite
    // and the migration path fan-out compile a richer, topology-aware config for the
    // hostnames they own. If this ordering inverts, a project-level row would flatten a
    // fan-out domain to a root-only proxy and drop its per-path locations.
    const projectLevel = SRC.indexOf("buildProjectServiceUpstream({");
    const composite = SRC.indexOf("buildCompositeRegistration({");
    const fanout = SRC.indexOf("buildDomainFanoutRegistrations({");
    expect(projectLevel).toBeGreaterThan(-1);
    expect(composite).toBeGreaterThan(projectLevel);
    expect(fanout).toBeGreaterThan(projectLevel);
  });

  it("never overwrites a hostname a SERVICE route already claimed this pass", () => {
    // The project's hostname set and a service's are disjoint in the DB (one row owns a
    // hostname), but the broader answer must never win if they ever aren't.
    expect(BLOCK).toContain("seenRouteDomains.has(routeKey)");
  });

  it("provisions SSL for the routes it registers, like every other route writer here", () => {
    // A vhost with no certificate was the other half of #618's symptom. The static and
    // proxied service paths both provision; a third writer that didn't would recreate it.
    expect(BLOCK).toContain("route.provisionSsl");
    expect(BLOCK).toContain("trackedSsl.provisionCert(route.hostname)");
  });

  it("keeps a failed registration non-fatal and skips the cert for it", () => {
    // Routing is best-effort by contract; and with no vhost there is nothing for ACME to
    // answer the challenge on, so attempting a cert would burn a guaranteed failure.
    expect(BLOCK).toContain("composeRouteWarnings.push");
  });
});

describe("compose deploy pairs a free project-level route with its cloud edge route", () => {
  it("syncs the managed edge proxy for a free *.opsh.io project hostname", () => {
    // A free hostname resolves ONLY through Openship Cloud's edge. The per-service loop
    // already pairs each of its free routes with `ensureManagedEdgeProxy`; a project-level
    // route that skipped it would have a working origin and nothing pointing at it.
    expect(BLOCK).toContain("route.isCloud && route.managedSubdomain");
    expect(BLOCK).toContain("ensureManagedEdgeProxy(");
  });
});
