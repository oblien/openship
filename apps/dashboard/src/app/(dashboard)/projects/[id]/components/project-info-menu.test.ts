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
    expect(card).toContain('className="rounded-2xl border border-border/50 bg-card"');
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
