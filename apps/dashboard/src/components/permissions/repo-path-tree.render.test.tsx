// No DOM needed: renderToStaticMarkup runs no effects, so the fetch never fires
// and the loading state is what renders — which is exactly the state to pin here.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { RepoPathTree } from "./RepoPathTree";

/**
 * The tree replaced a text box you had to type globs into blind. These pin the
 * affordances that make it usable — a search field and a scroll-bounded list — and
 * the design scale, so it can't regress to the cramped 10px styling the modal
 * originally shipped with.
 */

function render(selected: string[] = []) {
  return renderToStaticMarkup(
    <I18nProvider>
      <RepoPathTree owner="hydralerne" repo="charts" selected={selected} onChange={() => {}} />
    </I18nProvider>,
  );
}

describe("RepoPathTree", () => {
  it("offers a search field — the reason the tree is fetched recursively", () => {
    // Per-directory loading would make search impossible: you can only filter what
    // is already loaded.
    expect(render()).toContain('placeholder="Search files and folders…"');
  });

  it("bounds the list height by default so a large repo can't grow unbounded", () => {
    // Order-independent: the class list is composed conditionally now that the
    // modal can ask the tree to fill a column instead.
    const html = render();
    expect(html).toMatch(/max-h-\[\d+px\]/);
    expect(html).toContain("overflow-y-auto");
  });

  it("shows a loading state rather than an empty box while fetching", () => {
    expect(render()).toContain("Loading repository…");
  });

  it("disables search until the tree has arrived", () => {
    // Typing into a box that filters nothing reads as broken.
    expect(render()).toMatch(/placeholder="Search files and folders…"[^>]*disabled/);
  });

  it("uses the settled 13px scale, never the cramped or oversized ones", () => {
    const html = render();
    expect(html).toContain("text-[13px]");
    expect(html).not.toContain("text-[10px]");
    expect(html).not.toContain("text-sm");
  });
});
