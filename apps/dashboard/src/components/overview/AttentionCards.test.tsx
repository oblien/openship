import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/components/i18n-provider";
import { EDGE_ERROR, ISSUE_FIXTURES } from "@/components/issues/issue-fixtures";
import { IssuesCard, UpdatesCard } from "./AttentionCards";

/**
 * Do the home attention cards render what an operator needs to act on?
 *
 * These assertions are all consequences of the redesign's decisions, not decoration:
 * a stopped component must offer its fix, a GONE mail container must not (recreating
 * it needs setup's secrets), the control plane must offer the CLI instead of a button
 * that 403s, severity must ride the border rather than tinting every row, and the
 * diagnosis must be clamped rather than truncated — because a single truncated line
 * of an nginx error is what made these rows useless in a 320px column.
 *
 * They now render rows from the `/issues` feed, so this file also guards the swap:
 * every behaviour the card used to compute from container state must still hold when
 * the severity and the fix arrive on the row instead.
 *
 * Server-rendered to markup, matching MonitoringView.test.tsx: no jsdom, nothing new
 * installed. Interaction (clicking Fix) belongs to `useIssueActions`, not here.
 */

const card =
  (Card: typeof IssuesCard) =>
  (issues = ISSUE_FIXTURES.outage!, onHide?: () => void) =>
    renderToStaticMarkup(
      <I18nProvider>
        <Card
          issues={issues}
          busyId={null}
          onResolve={() => {}}
          onInfraFix={() => {}}
          onHide={onHide}
        />
      </I18nProvider>,
    );

const issues = card(IssuesCard);
const updates = card(UpdatesCard);

const broken = (key: keyof typeof ISSUE_FIXTURES) =>
  ISSUE_FIXTURES[key]!.filter((i) => i.severity !== "advisory");

describe("IssuesCard", () => {
  it("names the server, what broke on it, and the recorded failure", () => {
    const html = issues();
    expect(html).toContain("web-01");
    // The kind label, not the raw `edge`/`mail` ids in mono uppercase.
    expect(html).toContain("Edge down");
    expect(html).toContain("Mail engine down");
    expect(html).toContain("Address already in use");
  });

  it("clamps the diagnosis to two lines instead of truncating it to one", () => {
    const html = issues();
    expect(html).toContain("line-clamp-2");
    // The full text stays reachable on hover even when clamped.
    expect(html).toContain(`title="${EDGE_ERROR}"`);
  });

  it("carries severity in the header, not on the card edge or by tinting every row", () => {
    const html = issues();
    expect(html).toContain("bg-danger-bg"); // icon tile
    expect(html).toContain("text-danger"); // title
    expect(html).toContain("bg-card");
    expect(html).not.toContain("bg-danger/");
    // The edge stays the same hairline every other card on the page draws: a tinted
    // border turns the whole card into a status object, and a column of two of them
    // reads as colored boxes instead of a ranked list.
    expect(html).toContain("border-border/50");
    expect(html).not.toContain("border-danger-border");
  });

  it("offers a solid Fix for a stopped component", () => {
    const html = issues();
    expect(html).toContain("Fix");
    expect(html).toContain("bg-danger-solid");
  });

  it("stays at warning when nothing is actually down", () => {
    const html = issues(broken("action"));
    expect(html).toContain("bg-warning-bg");
    expect(html).not.toContain("bg-danger-bg");
    expect(html).not.toContain("text-danger");
    // An edge that was never installed installs, it doesn't get repaired.
    expect(html).toContain("Install");
  });

  it("refuses to offer a one-click fix when the mail container is gone", () => {
    const html = issues(ISSUE_FIXTURES.outage!.filter((i) => i.kind === "mail_down"));
    expect(html).toContain("Mail setup");
    expect(html).toContain("/emails");
    expect(html).not.toContain("bg-danger-solid"); // no destructive attempt offered
  });

  it("shows a held deploy's deadline so it can be answered before it aborts", () => {
    // The countdown is computed from `expiresAt`, which is why the fixture is relative.
    expect(issues(broken("action"))).toMatch(/Aborts in 1[0-9] min/);
  });

  it("caps the list and hands the remainder to the tracker", () => {
    const html = issues();
    // 4 issues, 3 rows → the 4th is only reachable via /issues.
    expect(html).toContain("web-01");
    expect(html).not.toContain("billing-api-worker");
    expect(html).toContain("1 more");
    expect(html).toContain('href="/issues"');
    // The header count still reports every issue, not just the visible ones.
    expect(html).toContain(">4<");
  });

  it("offers a hide control that doesn't look like the fix", () => {
    // Even the outage card can be cleared off the home page — it expires and a new
    // issue brings it back (`lib/attention-hide`). The button stays muted so it can't
    // be mistaken for the red action next to it, and it says what it does on hover.
    const html = issues(ISSUE_FIXTURES.outage!, () => {});
    expect(html).toContain('title="Hide until something changes"');
    expect(html).toContain('aria-label="Hide until something changes"');
    expect(html).toContain("text-muted-foreground/70");
  });

  it("renders no hide control where hiding means nothing", () => {
    // The fixture preview and the /issues groups pass no handler; a dead X on the
    // tracker would suggest the feed itself can be filtered.
    expect(issues()).not.toContain("Hide until something changes");
  });

  it("keeps a way into the tracker even when nothing overflowed", () => {
    // There is no Issues entry in the sidebar — this card IS the shortcut, so its
    // footer link cannot depend on a fourth row existing to appear.
    const html = issues(ISSUE_FIXTURES.outage!.slice(0, 1));
    expect(html).toContain('href="/issues"');
    expect(html).not.toMatch(/\d+ more/);
    expect(html).toContain("View all");
  });
});

describe("UpdatesCard", () => {
  it("shows the version transition per project", () => {
    const html = updates(ISSUE_FIXTURES.advisory!);
    expect(html).toContain("plausible");
    expect(html).toContain("v2.0.0 → v2.1.4");
  });

  it("wears the update accent without becoming an alarm", () => {
    // Amber header, but nothing that competes with "your site is down": no red anywhere,
    // and its rows keep the ghost control rather than a solid button.
    const html = updates(ISSUE_FIXTURES.advisory!);
    expect(html).toContain("bg-warning-bg");
    expect(html).toContain("text-warning");
    expect(html).not.toContain("bg-danger-bg");
    expect(html).not.toContain("bg-warning-solid");
    expect(html).not.toContain("bg-danger-solid");
  });

  it("offers the CLI command for the control plane, never an Update button", () => {
    const html = updates(ISSUE_FIXTURES.advisory!.filter((i) => i.scope === "platform"));
    expect(html).toContain("openship update");
    expect(html).toContain("updates itself from the command line");
  });

  it("names the server behind each managed component, not an aggregate count", () => {
    const html = updates(ISSUE_FIXTURES.advisory!);
    expect(html).toContain("Component update available");
    expect(html).toContain("web-02");
    expect(html).toContain("0.4.1 → 0.5.0");
  });

  it("counts every advisory in the header while showing at most four", () => {
    const many = [
      ...ISSUE_FIXTURES.advisory!,
      ...ISSUE_FIXTURES.advisory!.map((i, n) => ({ ...i, id: `dup:${n}`, title: `dup-${n}` })),
    ];
    const html = updates(many);
    expect(html).toContain(">8<");
    expect(html).toContain("4 more");
    expect(html).not.toContain("dup-3");
  });
});
