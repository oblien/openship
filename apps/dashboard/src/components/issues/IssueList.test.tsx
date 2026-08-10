import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/components/i18n-provider";
import { EDGE_ERROR, ISSUE_FIXTURES } from "./issue-fixtures";
import { IssueList } from "./IssueList";

/**
 * Does the feed's body group and render every row an operator can be handed?
 *
 * The grouping is the page's whole claim: one level, four scopes, worst first, each
 * panel toned by the WORST thing inside it. The failure modes are all silent —
 * a panel bordered "advisory" that contains an outage, a scope that renders nothing
 * because its bucket key drifted, a row whose fix disappeared because the server
 * sent `infraFix` instead of `resolveWith`. Markup assertions catch each of those;
 * none of them would throw.
 *
 * Server-rendered like AttentionCards.test.tsx — no jsdom. Clicking belongs to
 * `useIssueActions`; what's tested here is that the right control is even present.
 */

const render = (issues = ISSUE_FIXTURES.mixed!) =>
  renderToStaticMarkup(
    <I18nProvider>
      <IssueList issues={issues} busyId={null} onResolve={() => {}} onInfraFix={() => {}} />
    </I18nProvider>,
  );

/** Panel headers in document order — the grouping, independent of row content. */
const groupOrder = (html: string) =>
  [...html.matchAll(/text-\[14px\] font-semibold [^"]*">([^<]+)</g)].map((m) => m[1]);

describe("grouping", () => {
  it("renders one panel per scope present, outward by blast radius", () => {
    expect(groupOrder(render())).toEqual(["Openship", "Servers", "Projects", "Domains"]);
  });

  it("omits a scope with nothing in it rather than showing an empty panel", () => {
    // The advisory bucket has no domain rows, so there must be no Domains panel —
    // an empty group reads as "checked and fine", which this surface never claims.
    const html = render(ISSUE_FIXTURES.advisory!);
    expect(groupOrder(html)).toEqual(["Openship", "Servers", "Projects"]);
    expect(html).not.toContain("Custom hostnames and certificates");
  });

  it("renders nothing at all for an empty feed", () => {
    expect(groupOrder(render(ISSUE_FIXTURES.empty!))).toEqual([]);
  });

  it("counts the rows in each panel", () => {
    // mixed: 1 platform, 2 server, 4 project, 2 domain.
    const html = render();
    const counts = [...html.matchAll(/tabular-nums text-muted-foreground">(\d+)</g)].map(
      (m) => m[1],
    );
    expect(counts).toEqual(["1", "2", "4", "2"]);
  });

  it("keeps the server's ordering inside a panel — the worst row leads", () => {
    const html = render();
    // Both server rows are outages here; the feed sent edge-down first.
    expect(html.indexOf("web-01")).toBeLessThan(html.indexOf("eu-west-2"));
  });
});

describe("tone comes from the worst row in the panel", () => {
  it("heads a panel danger when it holds an outage, even beside milder rows", () => {
    const html = render(ISSUE_FIXTURES.outage!);
    expect(html).toContain("bg-danger-bg");
    expect(html).toContain("text-danger");
  });

  it("never renders danger for a page of setup gaps and held decisions", () => {
    // An edge that was never installed and a cert waiting on DNS are things to do,
    // not things that are down. If either escalates, every panel looks like an
    // outage and the distinction stops being readable.
    const html = render(ISSUE_FIXTURES.action!);
    expect(html).toContain("bg-warning-bg");
    expect(html).not.toContain("bg-danger-bg");
    expect(html).not.toContain("text-danger");
    expect(html).not.toContain("bg-danger-solid");
  });

  it("keeps advisories on the muted surface, with no status color anywhere", () => {
    const html = render(ISSUE_FIXTURES.advisory!);
    expect(html).not.toContain("bg-danger-bg");
    expect(html).not.toContain("bg-warning-bg");
    expect(html).not.toContain("text-warning");
    expect(html).not.toContain("text-danger");
  });

  it("draws the same neutral edge whatever the tone", () => {
    // Severity belongs to the header tile and title. Tinting the border makes the
    // card itself the status object, so a page of panels reads as colored boxes.
    for (const fixture of [ISSUE_FIXTURES.outage!, ISSUE_FIXTURES.action!, ISSUE_FIXTURES.advisory!]) {
      const html = render(fixture);
      expect(html).toContain("border-border/50");
      expect(html).not.toContain("border-danger-border");
      expect(html).not.toContain("border-warning-border");
    }
  });
});

describe("each row offers the fix the server attached, and only that", () => {
  it("gives a stopped component the infra Fix button", () => {
    const html = render(ISSUE_FIXTURES.outage!);
    expect(html).toContain("Edge down");
    expect(html).toContain(">Fix<");
    expect(html).toContain("bg-danger-solid");
  });

  it("labels a never-installed edge Install, not Fix", () => {
    const html = render(ISSUE_FIXTURES.action!);
    expect(html).toContain("Edge not installed");
    expect(html).toContain(">Install<");
    expect(html).not.toContain(">Fix<");
  });

  it("labels drift Update and keeps it a ghost control", () => {
    const html = render(ISSUE_FIXTURES.advisory!);
    expect(html).toContain("Component update available");
    expect(html).toContain(">Update<");
    expect(html).not.toContain("bg-danger-solid");
    expect(html).not.toContain("bg-warning-solid");
  });

  it("renders a resolution's own label as the button", () => {
    const html = render(ISSUE_FIXTURES.mixed!);
    // From `resolveWith[0]`, not a generic "Fix" — the server named the action.
    expect(html).toContain(">Retry<");
    expect(html).toContain(">Check DNS<");
  });

  it("sends a vanished mail engine to setup instead of offering a repair", () => {
    const html = render(ISSUE_FIXTURES.outage!);
    expect(html).toContain("Mail setup");
    expect(html).toContain('href="/emails"');
  });

  it("offers the CLI command for the control plane's own update", () => {
    const html = render(ISSUE_FIXTURES.advisory!);
    expect(html).toContain("openship update");
    expect(html).toContain("updates itself from the command line");
  });

  it("falls back to a View link when a row carries no fix at all", () => {
    const html = render([ISSUE_FIXTURES.mixed!.find((i) => i.kind === "server_unreachable")!]);
    expect(html).toContain(">View<");
    expect(html).toContain('href="/servers/s2"');
  });

  it("disables only the row whose fix is running", () => {
    const busy = ISSUE_FIXTURES.mixed!.find((i) => i.resolveWith.length > 0)!;
    const html = renderToStaticMarkup(
      <I18nProvider>
        <IssueList
          issues={ISSUE_FIXTURES.mixed!}
          busyId={busy.id}
          onResolve={() => {}}
          onInfraFix={() => {}}
        />
      </I18nProvider>,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html).toContain("animate-spin");
  });
});

describe("what a row says about itself", () => {
  it("links the title to the surface that owns the fix", () => {
    const html = render(ISSUE_FIXTURES.mixed!);
    expect(html).toContain('href="/projects/p1/health"');
    expect(html).toContain('href="/projects/p3/deployments"');
    expect(html).toContain('href="/settings?tab=instance"');
  });

  it("names the project a container incident belongs to", () => {
    // The title is the CONTAINER (snapshotted at incident time); the meta line is
    // what tells you which project to go look at.
    const html = render(ISSUE_FIXTURES.mixed!);
    expect(html).toContain("billing-api-worker");
    expect(html).toContain("billing-api ·");
  });

  it("does not repeat a server name that is already the title", () => {
    const html = render(ISSUE_FIXTURES.outage!);
    expect(html).not.toContain("web-01 · web-01");
  });

  it("shows a downtime clock only where an incident recorded one", () => {
    const html = render(ISSUE_FIXTURES.mixed!);
    expect(html).toMatch(/Started \d/);
    // The port advisory has no `since`, so its row shows the project and nothing else.
    expect(html).toContain("storefront</p>");
  });

  it("counts a held deploy's deadline down, never up", () => {
    const html = render(ISSUE_FIXTURES.action!);
    expect(html).toMatch(/Aborts in 1[0-9] min/);
    expect(html).not.toContain("Aborts in 0 min");
  });

  it("reports a resolved incident with the end of its clock and no action", () => {
    const html = render(ISSUE_FIXTURES.resolved!);
    expect(html).toMatch(/Resolved \d/);
    expect(html).not.toContain("bg-danger-solid");
    expect(html).toContain(">View<");
  });

  it("clamps a long diagnosis to two lines and keeps the full text on hover", () => {
    const html = render(ISSUE_FIXTURES.outage!);
    expect(html).toContain("line-clamp-2");
    expect(html).toContain(`title="${EDGE_ERROR}"`);
  });
});

describe("a fleet-sized feed", () => {
  it("renders every row it is given, grouped, with no cap", () => {
    const html = render(ISSUE_FIXTURES.fleet!);
    const rows = html.match(/<li class="py-2\.5/g) ?? [];
    expect(rows).toHaveLength(ISSUE_FIXTURES.fleet!.length);
    expect(groupOrder(html)).toEqual(["Servers", "Projects", "Domains"]);
  });
});
