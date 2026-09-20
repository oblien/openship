import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The Project Info card carries the project's ⋮ menu (rename / copy id / pause /
 * delete) and the name row's rename pencil.
 *
 * Two things about that card are load-bearing and invisible to a typecheck:
 *
 *   1. it must NOT have `overflow-hidden`. Every sibling SectionCard does, so the
 *      class reads like harmless consistency — but the ⋮ opens an absolutely
 *      positioned menu, and a clipping ancestor cuts it off at the header strip.
 *   2. the ⋮ and the pencil must open the SAME modal instance. Two copies of the
 *      form is how the previous rename UI ended up orphaned and forgotten.
 */
const src = readFileSync(new URL("./AdvancedSettings.tsx", import.meta.url), "utf8");
const card = src.slice(src.indexOf("{/* Project Info"), src.indexOf("{/* Project Status"));

describe("the Project Info card doesn't clip its own menu", () => {
  it("opens the card with a non-clipping container", () => {
    // The card SURFACE, not the whole class list. Pinning the exact string made any
    // layout change to this card fail for no reason — it broke when the card learned to
    // fill its grid cell (`flex h-full flex-col`), which cannot clip anything. The
    // invariant is the absence of `overflow-hidden`, asserted below; that is what is
    // load-bearing, and it is unchanged.
    expect(card).toContain("rounded-2xl border border-border/50 bg-card");
    // Only className VALUES are searched, so the comment explaining the absence of
    // the class doesn't itself satisfy the match.
    const clipping = (card.match(/className="[^"]*"/g) ?? []).filter((c) =>
      c.includes("overflow-hidden"),
    );
    expect(clipping).toEqual([]);
  });
});

describe("the Project Info card's project actions", () => {
  it("puts a ⋮ menu on the header", () => {
    expect(card).toContain("<DropdownMenu");
    expect(card).toContain("actions={menuActions}");
  });

  it("offers rename, copy id, pause/resume and delete", () => {
    for (const id of ["rename", "copy-id", "toggle", "delete"]) {
      expect(src).toContain(`id: "${id}"`);
    }
    // Pause and delete drive the controls this panel already owns rather than a
    // second implementation of either.
    expect(src).toContain("onClick: () => void handleDisableProject()");
    expect(src).toContain("onClick: () => setShowDeleteModal(true)");
  });

  it("routes both rename entry points at one modal instance", () => {
    expect((src.match(/setShowRenameModal\(true\)/g) ?? []).length).toBe(2); // ⋮ + pencil
    expect((src.match(/<ProjectRenameModal/g) ?? []).length).toBe(1);
  });
});

/**
 * The Migration card has the same hazard as the Project Info card above, from the other
 * direction: it goes THROUGH `SectionCard`, which clips its corners with `overflow-hidden`
 * — and the card's content opens a server dropdown that has to escape it. Clipped, the menu
 * is cut off at the card's lower edge and the servers below the fold cannot be picked.
 *
 * Invisible to a typecheck and to any static render (the menu only exists once open), so
 * it is pinned here in source.
 */
const migrationCard = src.slice(src.indexOf("{/* Migration"), src.indexOf("{/* Routing"));

describe("the Migration card doesn't clip its server dropdown", () => {
  it("opts out of SectionCard's corner clip", () => {
    expect(migrationCard).toContain("allowOverflow");
  });

  it("SectionCard actually honours that opt-out", () => {
    // The prop existing is not the same as it reaching the class list — assert the branch
    // that drops `overflow-hidden` is really there.
    expect(src).toContain('allowOverflow ? "" : "overflow-hidden"');
  });

  it("still clips by default, so every other card keeps its rounded corners", () => {
    expect(src).toContain("allowOverflow = false");
  });
});
