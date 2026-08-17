import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A WARNING is not a DECISION.
 *
 * A successful deploy can warn about several things — domains not routed yet, domains routed with
 * no TLS certificate — and none of them means a service failed. The client inferred otherwise
 * (`decisionPending: data?.decisionPending ?? !!warningMessage`), so a cert advisory on a clean
 * deploy opened the failed-services keep/reject modal reading:
 *
 *   "Deployment finished with failed services · 0 of 5 services failed · Retry 0 Failed Services"
 *
 * Two halves, both pinned: the server SAYS when it is holding a decision, and the client believes
 * only that.
 */
const pipeline = readFileSync(new URL("./build-pipeline.ts", import.meta.url), "utf8");
const lifecycle = readFileSync(new URL("./deployment-lifecycle.ts", import.meta.url), "utf8");

const codeOnly = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("the server announces a held decision on the live event", () => {
  it("sends decisionPending with the partial-failure SSE meta", () => {
    const partial = pipeline.slice(pipeline.indexOf('rolled === "partial_failure"'));
    expect(codeOnly(partial.slice(0, 2500))).toContain("decisionPending: true");
  });

  it("the SSE meta type carries the field, so it can't be dropped silently", () => {
    expect(codeOnly(lifecycle)).toContain("decisionPending?: boolean");
  });

  it("only the partial-failure branch sets it", () => {
    // A routing/TLS warning on success must not carry it — that is the whole bug.
    const code = codeOnly(pipeline);
    expect(code.match(/decisionPending: true/g) ?? []).toHaveLength(1);
  });
});

describe("routeIssuesWarning is advisory only", () => {
  it("describes TLS-pending domains as routed, not as failures", async () => {
    const { routeIssuesWarning } = await import("./deployment-lifecycle");
    const msg = routeIssuesWarning([], ["api.example.com", "app.example.com"]);
    expect(msg).toContain("routed but have no HTTPS certificate yet");
    // The remedy is DNS + Verify, never "some services failed".
    expect(msg).toContain("Verify from the Domains tab");
    expect(msg.toLowerCase()).not.toContain("service");
  });

  it("says nothing at all when there is nothing to say", () => {
    // An empty warning must not become a truthy signal anywhere downstream.
    return import("./deployment-lifecycle").then(({ routeIssuesWarning }) => {
      expect(routeIssuesWarning([], [])).toBe("");
    });
  });
});
