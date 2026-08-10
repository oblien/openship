import { describe, expect, it, vi } from "vitest";

// The function under test is pure; everything else this module reaches (DB, SSE,
// notifications, favicon probing) is a side effect the assertion doesn't want.
// `@repo/adapters` stays REAL — `isEdgeDownMessage` is the branch being pinned.
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("../../lib/notification-dispatcher", () => ({ notification: {} }));
vi.mock("../../lib/audit", () => ({ audit: {} }));
vi.mock("../../lib/favicon-detector", () => ({ detectAndStoreFavicon: vi.fn() }));
vi.mock("./session-manager", () => ({}));
vi.mock("../mail/webmail/webmail-project.service", () => ({
  markWebmailInstalled: vi.fn(),
  mailServerIdFromWebmailSlug: vi.fn(),
}));

import { routeIssuesWarning } from "./deployment-lifecycle";

/**
 * Both pipelines fold routing failures into the same `edgeUnsynced` →
 * "Action Required" + Retry signal, so they must not disagree about what to tell the
 * operator to do — hence one builder, and hence this test on the branch inside it.
 */
describe("routeIssuesWarning", () => {
  it("sends an unresolved domain to DNS/routing, as before", () => {
    const msg = routeIssuesWarning([
      "test.hekai.org: DNS problem: NXDOMAIN looking up A for test.hekai.org",
    ]);
    expect(msg).toMatch(/fix DNS\/routing and Retry from the Domains tab/);
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
});
