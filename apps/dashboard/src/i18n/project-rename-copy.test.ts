import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { locales } from "./index";

/**
 * The rename modal's copy is safety copy, not decoration.
 *
 * The server freezes a project's slug on rename — the slug names its docker network,
 * its container names and its volumes, and it seeded the free `*.opsh.io` hostname.
 * Renaming used to recompute it, which moved the live URL and pointed the next deploy
 * at empty volumes. The freeze is the fix; this copy is the only place the user is
 * told about it. If a locale drops the `{slug}` placeholder, that locale's users get a
 * sentence that claims an identity is kept without saying which — the one fact the
 * note exists to deliver.
 *
 * Checked in EVERY locale (unlike host-channel-copy, which relies on the English
 * fallback): these strings ARE translated in all nine, so a future edit that mangles
 * one is a real regression rather than a missing translation degrading to English.
 */
describe("the rename modal states the frozen identity in every locale", () => {
  const blocks = locales.map((locale) => {
    const json = JSON.parse(
      readFileSync(new URL(`./locales/${locale}/projectSettings.json`, import.meta.url), "utf8"),
    );
    return [locale, json.advanced.rename, json.advanced.projectMenu] as const;
  });

  it.each(blocks)("%s: identityNote names the slug it keeps", (_locale, rename) => {
    expect(rename.identityNote).toContain("{slug}");
  });

  it.each(blocks)("%s: the renamed toast names the new name", (_locale, rename) => {
    expect(rename.toast.renamed).toContain("{name}");
  });

  it.each(blocks)("%s: carries every key the modal renders", (_locale, rename) => {
    for (const key of ["title", "description", "label", "placeholder", "save", "cancel"]) {
      expect(rename[key], key).toBeTruthy();
    }
    expect(rename.toast.failed).toBeTruthy();
  });

  it.each(blocks)("%s: carries every ⋮ menu label", (_locale, _rename, menu) => {
    for (const key of [
      "rename",
      "copyId",
      "idCopied",
      "copyFailed",
      "pause",
      "resume",
      "delete",
    ]) {
      expect(menu[key], key).toBeTruthy();
    }
  });

  it.each(blocks)("%s: takes no placeholder the modal doesn't pass", (_locale, rename) => {
    // The modal interpolates exactly `{slug}` here and `{name}` in the toast. Any
    // other placeholder renders literally, as `{foo}`, on screen.
    expect(rename.identityNote.match(/\{\w+\}/g) ?? []).toEqual(["{slug}"]);
    expect(rename.toast.renamed.match(/\{\w+\}/g) ?? []).toEqual(["{name}"]);
    expect(rename.description).not.toMatch(/\{\w+\}/);
  });
});
