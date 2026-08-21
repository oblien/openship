import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { CustomSelect } from "./CustomSelect";

/**
 * Regression test for Supabase / database connection dropdown scrolling bug.
 *
 * Problem:
 * When connecting a Supabase database to a project (via "Use in a project" modal),
 * the target project dropdown menu could not be scrolled when there were many projects.
 * The portal outer container had `overflow-hidden` and `maxHeight`, but lacked
 * `flex flex-col`, causing the child `max-h-full` to fail resolving against parent
 * indefinite height (`height: auto`). The inner container expanded to full content
 * height, preventing `overflow-y-auto` from activating, while the outer container
 * clipped the content at `maxHeight` (e.g. 256px).
 *
 * Fix:
 * 1. Outer container has `flex flex-col overflow-hidden` with `maxHeight`.
 * 2. Inner container has `min-h-0 flex-1 overflow-y-auto` so flexbox constrains
 *    the inner container to available height and properly activates vertical scrolling.
 */
describe("CustomSelect — scrollable dropdown structure", () => {
  const options = Array.from({ length: 25 }, (_, i) => ({
    value: `proj-${i + 1}`,
    label: `Project ${i + 1}`,
    description: `project-${i + 1}.example.com`,
  }));

  it("renders trigger button with placeholder when unselected", () => {
    const html = renderToStaticMarkup(
      <CustomSelect
        value=""
        options={options}
        onChange={() => {}}
        placeholder="Select a project…"
      />,
    );

    expect(html).toContain("Select a project…");
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).toContain('aria-expanded="false"');
  });

  it("renders selected option label and description when value matches", () => {
    const html = renderToStaticMarkup(
      <CustomSelect
        value="proj-3"
        options={options}
        onChange={() => {}}
        placeholder="Select a project…"
      />,
    );

    expect(html).toContain("Project 3");
    expect(html).toContain("project-3.example.com");
  });

  it("ensures CustomSelect source code uses flex-col on outer menu and min-h-0 flex-1 overflow-y-auto on inner list", () => {
    const sourcePath = resolve(__dirname, "CustomSelect.tsx");
    const source = readFileSync(sourcePath, "utf-8");

    // Outer portal container must be flex flex-col to bound children in flex layout
    expect(source).toMatch(/className="[^"]*flex flex-col overflow-hidden[^"]*bg-popover/);

    // Inner options list must have min-h-0 flex-1 overflow-y-auto to scroll when content exceeds max-height
    expect(source).toMatch(/className="[^"]*min-h-0 flex-1 overflow-y-auto[^"]*"/);
  });
});
