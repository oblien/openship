// No DOM needed: renderToStaticMarkup runs no effects, and the modal seeds its
// state from props on the first render (deliberately, not in an effect).
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SourceAccessScope } from "@repo/core";
import { I18nProvider } from "@/components/i18n-provider";
import { SourceAccessModal } from "./SourceAccessModal";
import type { Permission } from "@/lib/api";

/**
 * The summary is the part an operator actually reads before granting access, so
 * what it SAYS has to match what the grant does. These render the real component
 * and assert against visible text — the logic itself is covered by
 * source-access.test.ts.
 */

function render(opts: {
  scope?: SourceAccessScope | null;
  permissions?: Permission[];
  open?: boolean;
  wholeAccount?: boolean;
  targetLabel?: string;
}) {
  return renderToStaticMarkup(
    <I18nProvider>
      <SourceAccessModal
        open={opts.open ?? true}
        onClose={() => {}}
        targetLabel={opts.targetLabel ?? "hydralerne/charts"}
        wholeAccount={opts.wholeAccount}
        permissions={opts.permissions ?? ["read"]}
        scope={opts.scope}
        onApply={() => {}}
      />
    </I18nProvider>,
  );
}

function text(html: string) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("SourceAccessModal", () => {
  it("renders nothing when closed", () => {
    expect(render({ open: false })).toBe("");
  });

  it("names the repo it is granting access to", () => {
    expect(text(render({}))).toContain("hydralerne/charts");
  });

  it("a grant with no scope reads as deploy-only, and says no contents are readable", () => {
    const out = text(render({ scope: null }));
    expect(out).toContain("No file contents can be read");
    // No path editor at deploy tier — there is nothing to scope.
    expect(out).not.toContain("Readable paths");
  });

  it("a whole-repo grant says every file is readable AND that clones work", () => {
    const out = text(render({ scope: { v: 1, read: { paths: ["**"] } } }));
    expect(out).toContain("Reading every file.");
    expect(out).toContain("local builds work");
  });

  it("a path-scoped grant lists the paths and WARNS that clones are blocked", () => {
    // The consequence an operator would otherwise discover when a deploy fails.
    const out = text(render({ scope: { v: 1, read: { paths: ["src/**"] } } }));
    expect(out).toContain("Reading only: src/**");
    expect(out).toContain("local builds won't work");
  });

  it("shows the read paths as editable chips", () => {
    const out = render({ scope: { v: 1, read: { paths: ["src/**", "package.json"] } } });
    expect(text(out)).toContain("Readable paths");
    expect(text(out)).toContain("src/**");
    expect(text(out)).toContain("package.json");
    // Each chip is removable.
    expect(out).toContain('aria-label="Remove src/**"');
  });

  it("a write scope is shown only when the grant carries the write verb", () => {
    const scope: SourceAccessScope = {
      v: 1,
      read: { paths: ["src/**"] },
      write: { paths: ["src/gen/**"] },
    };
    // read-only grant → the write surface is inert server-side, so it is not shown
    expect(text(render({ scope, permissions: ["read"] }))).not.toContain("Writable paths");
    // write grant → shown, with its own paths
    const withWrite = text(render({ scope, permissions: ["read", "write"] }));
    expect(withWrite).toContain("Writable paths");
    expect(withWrite).toContain("Writing only: src/gen/**");
  });

  it("flags whole-repo write as the widest setting", () => {
    const out = text(
      render({ scope: { v: 1, read: { paths: ["**"] }, write: { paths: ["**"] } }, permissions: ["read", "write"] }),
    );
    expect(out).toContain("Writing any file.");
  });

  /**
   * The consent screen's default template grants ORG-level access, and with a
   * whole-org grant active the repo rows collapse to "covered by the org-wide
   * grant" — so the account row is the only reachable entry point there. The rules
   * are identical for both widths; only the breadth stated to the operator differs.
   */
  it("states the breadth when editing a whole account, not a single repo", () => {
    const out = text(render({ wholeAccount: true, targetLabel: "Hydralerne" }));
    expect(out).toContain("every repository under Hydralerne");
  });

  it("still reads as a single repo when it is one", () => {
    const out = text(render({}));
    expect(out).not.toContain("every repository under");
    expect(out).toContain("read from hydralerne/charts");
  });

  it("offers all three tiers", () => {
    const out = text(render({}));
    expect(out).toContain("Deploy only");
    expect(out).toContain("Read files");
    expect(out).toContain("Read and write");
  });

  /**
   * Design contract. The first cut of this modal used text-[10px]/text-[11px] for
   * body copy and had no padding of its own — Modal renders {children} bare, so the
   * footer sat flush in the panel's rounded corner and Apply appeared to overflow.
   * These pin the scale so it can't drift small again, and the two-column shape
   * that keeps a repo-sized tree from pushing the footer off screen.
   */
  describe("matches the page's design scale", () => {
    const html = () => render({ scope: { v: 1, read: { paths: ["src/**"] } } });

    it("owns its padding, so content is never flush against the clipped corner", () => {
      expect(html()).toContain("px-6");
    });

    it("separates the footer with a border, like the app's other modals", () => {
      expect(html()).toMatch(/border-t[^"]*px-6/);
    });

    it("titles with the app's MODAL heading style", () => {
      // text-base font-semibold, as UseInProjectModal and IncomingWebhooks use.
      // ScopeEditor's text-[14px] is its in-page SECTION heading — a dialog title
      // sits a step above that in the hierarchy, and this is now a wide dialog.
      expect(html()).toContain("text-base font-semibold");
      expect(html()).not.toContain("text-[14px]");
    });

    it("uses the settled 13px body scale, not the cramped or oversized ones", () => {
      const out = html();
      expect(out).not.toContain("text-[10px]");
      expect(out).toContain("text-[13px]");
    });

    it("ALWAYS keeps the footer reachable — it was clipped once", () => {
      // The bug: `min-h-[380px]` replaced `min-h-0` on the browse column, so the
      // column could no longer shrink. The tree grew to natural height, the panel
      // passed maxHeight, and overflow:hidden cut the footer off entirely. The floor
      // belongs on the LIST (bounded by max-h) so the column can still shrink.
      const out = html();
      expect(out).toContain("min-h-0");
      expect(out).toMatch(/min-h-\[\d+px\] max-h-\[\d+vh\]/);
      expect(out).toContain("<footer");
      expect(out).toContain(">Apply<");
    });

    it("animates its width, narrow at deploy and wide when browsing", () => {
      expect(html()).toContain("transition-[width]");
      // Two distinct widths, and the browse one is the wider.
      expect(render({ scope: null })).toContain("w-[min(560px,92vw)]");
      expect(html()).toContain("w-[min(880px,95vw)]");
    });

    it("uses text-sm for the footer actions, matching other modal buttons", () => {
      expect(html()).toMatch(/px-3\.5 py-2 text-sm font-medium/);
    });

    it("puts the tree on the LEFT and the chosen rules on the RIGHT", () => {
      // A single stacked column made the modal taller than the viewport on any real
      // repo — the footer was cut off. The browser gets the room; what has been
      // picked sits beside it, visible while you pick.
      const out = html();
      expect(out).toMatch(/lg:flex-row/);
      const left = out.indexOf("Search files and folders");
      const right = out.indexOf("Readable paths");
      expect(left).toBeGreaterThan(-1);
      expect(right).toBeGreaterThan(left);
      // The right column is a fixed rail, the left one flexes.
      expect(out).toMatch(/lg:w-\[\d+px\]/);
    });

    it("scrolls INSIDE the columns, so the footer always stays reachable", () => {
      // No `h-full`: the panel is content-sized now (that is what lets the deploy
      // tier be compact), so a full-height root would fight its own sizing.
      const out = html();
      expect(out).toMatch(/min-h-0 flex-1/);
      // The footer is pinned rather than pushed.
      expect(out).toMatch(/flex shrink-0 items-center justify-end[^"]*border-t/);
    });

    it("drops to one column at the deploy tier — nothing to browse", () => {
      const out = render({ scope: null });
      expect(out).not.toContain("Search files and folders");
      expect(out).not.toMatch(/lg:flex-row/);
    });

    it("gives its own section labels the small-caps treatment", () => {
      // Settled scale after two overcorrections: 10px/11px body was cramped, 14px
      // was oversized. Body is text-[13px]; 11px is the uppercase LABEL treatment
      // only. Asserted on the labels this component owns; the tier control is a
      // shared LevelSwitch and keeps its own segment styling.
      const out = html();
      for (const label of ["Readable paths", "This grant allows"]) {
        const idx = out.indexOf(label);
        expect(idx, `${label} should render`).toBeGreaterThan(-1);
        // The class attribute immediately preceding the label text.
        const before = out.slice(Math.max(0, idx - 200), idx);
        expect(before, `${label} should use the uppercase label style`).toMatch(
          /text-\[11px\][^"]*uppercase[^"]*tracking-wider/,
        );
      }
    });
  });
});
