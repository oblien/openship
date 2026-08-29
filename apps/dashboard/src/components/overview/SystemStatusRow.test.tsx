import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/components/i18n-provider";
import { ISSUE_FIXTURES } from "@/components/issues/issue-fixtures";
import type { SystemIssue } from "@/lib/api/issues";
import SystemStatusRow from "./SystemStatusRow";

/**
 * The Activity card's status line — a roll-up, and the only thing on the home page
 * that speaks when nothing is wrong.
 *
 * The assertions that matter are the ones that keep it from becoming a second copy of
 * the attention cards: advisories are not faults, the count is a number rather than a
 * restatement of the rows, and an unread feed says nothing at all.
 */

const row = (broken: SystemIssue[], loaded = true) =>
  renderToStaticMarkup(
    <I18nProvider>
      <SystemStatusRow broken={broken} loaded={loaded} />
    </I18nProvider>,
  );

const brokenIn = (key: keyof typeof ISSUE_FIXTURES) =>
  ISSUE_FIXTURES[key]!.filter((i) => i.severity !== "advisory");

describe("SystemStatusRow", () => {
  it("reads operational, and offers no link, when nothing is broken", () => {
    const html = row([]);
    expect(html).toContain("Operational");
    expect(html).toContain("text-success");
    // Nothing to look at → no affordance to click. The row still states the status.
    expect(html).not.toContain('href="/issues"');
  });

  it("treats a pending update as operational, not a fault", () => {
    // The row is handed the feed's `broken` split, so advisories never reach it — this
    // pins that the split holds for an updates-only fleet, which is what keeps this
    // line from restating the Updates card sitting right below it.
    expect(brokenIn("advisory")).toHaveLength(0);
    expect(row(brokenIn("advisory"))).toContain("Operational");
  });

  it("counts what's broken and opens the tracker", () => {
    const html = row(brokenIn("outage"));
    expect(html).toContain("4 issues");
    expect(html).toContain('href="/issues"');
    expect(html).toContain("text-danger");
  });

  it("stays amber when things need an answer but nothing is down", () => {
    const html = row(brokenIn("action"));
    expect(html).toContain("5 issues");
    expect(html).toContain("text-warning");
    expect(html).not.toContain("text-danger");
  });

  it("says one issue, not 1 issues", () => {
    expect(row(ISSUE_FIXTURES.outage!.slice(0, 1))).toContain("1 issue<");
  });

  it("claims nothing until the feed has answered", () => {
    // "Operational" before `/issues` replies would be a guess, and the guess is always
    // the reassuring one.
    const html = row([], false);
    expect(html).not.toContain("Operational");
    expect(html).toContain("–");
    expect(html).toContain("text-muted-foreground");
  });
});
