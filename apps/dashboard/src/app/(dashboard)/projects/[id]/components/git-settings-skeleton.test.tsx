import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GitSettingsSkeleton } from "./GitSettingsSkeleton";

/**
 * The Source tab's skeleton was a transparent outline holding translucent slivers, with a
 * comment defending it as "not a solid full-card fill". It read as a wireframe rather than
 * as the app, and the same shape had been rejected once before.
 *
 * These pin the house pattern — `bg-card` shell, solid `bg-muted` blocks, filled inner
 * panels — because "it looks like a wireframe" is not something a typecheck can see.
 */

const html = renderToStaticMarkup(<GitSettingsSkeleton />);

describe("the Source skeleton looks like the card it replaces", () => {
  it("is a filled card, not a bare outline", () => {
    // The loaded card is `rounded-2xl border border-border/50 bg-card p-5`. A skeleton
    // missing bg-card shows the page background through it and reads as a hole.
    expect(html).toContain("rounded-2xl border border-border/50 bg-card p-5");
  });

  it("uses solid bg-muted blocks, never near-invisible slivers", () => {
    // Word-boundary, not a trailing space: `bg-muted` is often the last class in a list.
    expect(html).toMatch(/\bbg-muted\b(?!\/)/);
    // At /30 on a dark card surface the blocks were barely distinguishable from the card.
    expect(html).not.toContain("bg-muted/30");
    expect(html).not.toContain("bg-muted/50");
  });

  it("fills its inner panels, because the real rows are filled too", () => {
    // The real repository row carries bg-muted/20. Bare-bordered placeholders meant the
    // fill only appeared after loading, so the layout visibly changed twice.
    const panels = html.match(/rounded-xl border border-border\/50 bg-muted\/20/g) ?? [];
    expect(panels.length).toBeGreaterThanOrEqual(3); // repository row + rollback pair
    expect(html).not.toMatch(/rounded-xl border border-border\/50(?! bg-)/);
  });

  it("still reserves the loaded layout so nothing reflows", () => {
    // header + repository row + 2 rollback cards + 4 commit rows.
    expect((html.match(/rounded-full/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(html).toContain("sm:grid-cols-2");
  });

  it("animates, so it reads as loading rather than as broken empty content", () => {
    expect(html).toContain("animate-pulse");
  });
});
