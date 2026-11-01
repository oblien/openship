import { describe, expect, it, vi } from "vitest";

// The function under test is pure; everything else this module reaches (DB, SSE,
// notifications, favicon probing) is a side effect the assertion doesn't want.
// `@repo/adapters` stays REAL — `isEdgeDownMessage` is the branch being pinned.
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("@repo/platform/engine/lib/notification-dispatcher", () => ({ notification: {} }));
vi.mock("../../lib/audit", () => ({ audit: {} }));
vi.mock("@repo/platform/engine/lib/favicon-detector", () => ({ detectAndStoreFavicon: vi.fn() }));
vi.mock("@repo/platform/engine/modules/deployments/session-manager", () => ({}));
vi.mock("@repo/platform/engine/modules/mail/webmail/webmail-install.service", () => ({
  onWebmailDeployed: vi.fn(),
}));

import { routeIssuesWarning } from "@repo/platform/engine/modules/deployments/deployment-lifecycle";

/**
 * Both pipelines fold routing failures into the same `edgeUnsynced` →
 * "Action Required" + Retry signal, so they must not disagree about what to tell the
 * operator to do — hence one builder, and hence this test on the branch inside it.
 */
describe("routeIssuesWarning", () => {
  it("does not describe a failed SSH update as proof that a working domain is unrouted", () => {
    const msg = routeIssuesWarning([
      "www.example.com: Cannot reach root@192.0.2.20:22 over SSH (connect ENETUNREACH)",
    ]);
    expect(msg).toContain("could not be confirmed");
    expect(msg).toContain("ENETUNREACH");
    expect(msg).toContain("Retry from the Domains tab");
    expect(msg).not.toContain("aren't routed yet");
    expect(msg).not.toContain("fix DNS");
  });

  it("preserves a confirmed DNS error and directs the operator to Retry", () => {
    const msg = routeIssuesWarning([
      "test.hekai.org: DNS problem: NXDOMAIN looking up A for test.hekai.org",
    ]);
    expect(msg).toContain("Retry from the Domains tab");
    expect(msg).toContain("NXDOMAIN");
  });

  // The wording this fix exists to stop. A crash-looping edge produced "fix DNS/routing
  // and Retry" — the routes were fine, nothing was serving them, and Retry could not
  // succeed until the edge started. Sending an operator to their DNS provider over a
  // dead OpenResty costs them the whole debugging session.
  it("says the EDGE is down when that's what failed, and never mentions DNS", () => {
    const msg = routeIssuesWarning([
      `test.hekai.org: the edge container is not running ("openship-edge") (restarting) — it is ` +
        `crash-looping, so nothing that runs through the edge on this server can work.`,
    ]);
    expect(msg).toMatch(/the edge on this server is down/);
    expect(msg).toMatch(/Bring the edge back up/);
    expect(msg).not.toMatch(/fix DNS/);
  });

  it("recognises the condition from a RAW daemon error too", () => {
    // A warning can be assembled on a path that never went through an edge executor,
    // so the classifier must not depend on the message having been enriched first.
    const msg = routeIssuesWarning([
      "test.hekai.org: Error response from daemon: Container b8968804d6a7 is restarting, " +
        "wait until the container is running",
    ]);
    expect(msg).toMatch(/the edge on this server is down/);
  });

  it("keeps every detail it was given, whichever branch it takes", () => {
    const issues = ["a.example.com: NXDOMAIN", "b.example.com: Timeout during connect"];
    const msg = routeIssuesWarning(issues);
    for (const issue of issues) expect(msg).toContain(issue);
  });

  it("directs a certificate problem to Verify and preserves the observed reason", () => {
    const msg = routeIssuesWarning(
      [],
      ["api.example.com: no usable HTTPS certificate was found on this server"],
    );
    expect(msg).toContain("HTTPS could not be confirmed for 1 domain");
    expect(msg).toContain("Verify from the Domains tab");
    expect(msg).toContain("no usable HTTPS certificate was found");
    expect(msg).not.toContain("Retry");
    expect(msg).not.toContain("point DNS");
    expect(msg).toContain("api.example.com");
  });

  it("states both outcomes when a deploy hit each, without blurring them together", () => {
    const msg = routeIssuesWarning(
      ["a.example.com: NXDOMAIN"],
      ["b.example.com: no HTTPS certificate yet"],
    );
    expect(msg).toContain("Retry from the Domains tab");
    expect(msg).toContain("HTTPS could not be confirmed for 1 domain");
    expect(msg).toContain("a.example.com");
    expect(msg).toContain("b.example.com");
  });

  it("pluralises the count of domains whose HTTPS needs attention", () => {
    const msg = routeIssuesWarning([], ["a.example.com: x", "b.example.com: y"]);
    expect(msg).toContain("HTTPS could not be confirmed for 2 domains");
  });

  it("returns nothing when there is nothing to report", () => {
    expect(routeIssuesWarning([])).toBe("");
  });
});

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({ audit: {} }));
