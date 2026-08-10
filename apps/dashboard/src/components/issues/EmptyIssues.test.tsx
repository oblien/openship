import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { I18nProvider } from "@/components/i18n-provider";
import { EmptyIssues } from "./EmptyIssues";

/**
 * An empty feed is the state an operator sees most of the time, so the copy carries
 * more weight here than anywhere else on the page: it has to say WHICH nothing this is.
 *
 * The regression these tests exist for is a collapsed branch — "no resolved incidents"
 * rendering the healthy-fleet line, or a filtered-out list claiming nothing is wrong.
 * Both would render fine and quietly tell an operator their infrastructure is healthy
 * when the page has simply been narrowed.
 *
 * `IssuesView` owns the fourth piece of empty-state copy (the Resolved tab's coverage
 * caveat, `issues.resolvedNote`); it renders inside the fetching component behind tab
 * state, so it is verified by the fixture preview and the live pass, not here.
 */

const render = (props: { filtered: boolean; resolved: boolean }) =>
  renderToStaticMarkup(
    <I18nProvider>
      <EmptyIssues {...props} />
    </I18nProvider>,
  );

describe("the three nothings", () => {
  it("says the fleet is clear when nothing was reported at all", () => {
    const html = render({ filtered: false, resolved: false });
    expect(html).toContain("Nothing needs attention");
    // Names what was checked, so silence reads as coverage rather than absence.
    expect(html).toContain("Checks keep running in the background.");
  });

  it("says history is empty without claiming the fleet is healthy", () => {
    const html = render({ filtered: false, resolved: true });
    expect(html).toContain("No resolved incidents");
    expect(html).not.toContain("Nothing needs attention");
    // Retention is part of the message: an empty history may just be old.
    expect(html).toContain("30 days");
  });

  it("blames the filter when rows exist but none match", () => {
    // The important half is the negative: a narrowed page must never render either
    // reassurance, because there IS something wrong — it is just filtered out.
    const html = render({ filtered: true, resolved: false });
    expect(html).toContain("No matches");
    expect(html).not.toContain("Nothing needs attention");
    expect(html).not.toContain("No resolved incidents");
  });

  it("keeps the filter explanation when the resolved tab is also narrowed", () => {
    const html = render({ filtered: true, resolved: true });
    expect(html).toContain("No matches");
    expect(html).not.toContain("No resolved incidents");
  });

  it("stays a neutral surface — an empty feed is not a status", () => {
    // Every variant, including the both-flags combo: the illustration is chosen by the
    // same precedence as the copy, so a collapsed branch would tint here too.
    for (const props of [
      { filtered: false, resolved: false },
      { filtered: false, resolved: true },
      { filtered: true, resolved: false },
      { filtered: true, resolved: true },
    ]) {
      const html = render(props);
      // Both forms: the fill/tint variants are how a status hue would most plausibly
      // arrive in an illustration, and IssueList already pins the bg-* spelling.
      for (const token of [
        "text-danger",
        "text-warning",
        "text-success",
        "danger-bg",
        "warning-bg",
        "success-bg",
        "st-success",
      ]) {
        expect(html).not.toContain(token);
      }
    }
  });

  it("draws the panel an issue would land in, not a verdict icon", () => {
    // The reassurance is structural — the empty state occupies the same silhouette as a
    // real IssueGroup. Its one accent is var(--primary), which resolves to --th-btn-bg
    // and is achromatic in all three themes; a literal hex here would escape the
    // neutrality check above, since it never goes through a Tailwind class.
    const html = render({ filtered: false, resolved: false });
    expect(html).toContain("var(--primary)");
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    // Decorative: the h3 stays the accessible name for the whole card.
    expect(html).toContain('aria-hidden="true"');
  });
});
