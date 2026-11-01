import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { locales } from "./index";

/**
 * The connect toast and hint must stay true in every locale.
 *
 * `connectedN` is interpolated with exactly `{count}` and `{project}`. The form
 * renders `connected` and `redeployHint` verbatim, so any placeholder in them
 * would show on screen as a literal `{x}`. Checked in every locale because all
 * ten carry their own translation of these strings.
 */
describe("the connection form copy keeps its placeholders in every locale", () => {
  const blocks = locales.map((locale) => {
    const json = JSON.parse(
      readFileSync(new URL(`./locales/${locale}/projects.json`, import.meta.url), "utf8"),
    );
    return [locale, json.connections] as const;
  });
  const placeholders = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();

  it.each(blocks)("%s: connectedN takes exactly {count} and {project}", (_locale, c) => {
    expect(placeholders(c.connectedN)).toEqual(["{count}", "{project}"]);
  });

  it.each(blocks)("%s: connected and redeployHint take no placeholder", (_locale, c) => {
    expect(c.connected).toBeTruthy();
    expect(c.redeployHint).toBeTruthy();
    expect(placeholders(c.connected)).toEqual([]);
    expect(placeholders(c.redeployHint)).toEqual([]);
  });
});
