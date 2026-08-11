/**
 * Country display names and flags for the visitor map.
 *
 * Names come from `Intl.DisplayNames`, not a committed table. Two reasons: it
 * covers every code in country-paths.json (all 173, verified at generation time),
 * and it LOCALIZES — a table would pin the map to English while the other eight
 * locales translate everything around it. It ships with the JS engine, so this
 * costs nothing.
 *
 * Flags live in CountryFlag.tsx, which uses the `country-flag-icons` SVGs the servers
 * pages already use. This file used to derive emoji flags arithmetically from the ISO
 * code, which was elegant and broken: Windows ships no regional-indicator glyphs, so
 * every flag degraded to two letters there.
 */

// One instance per locale. `Intl.DisplayNames` construction is not free and the
// map calls this ~173 times per render.
const cache = new Map<string, Intl.DisplayNames | null>();

function namerFor(locale: string): Intl.DisplayNames | null {
  const hit = cache.get(locale);
  if (hit !== undefined) return hit;
  let namer: Intl.DisplayNames | null = null;
  try {
    namer = new Intl.DisplayNames([locale, "en"], { type: "region" });
  } catch {
    // Unsupported locale tag / trimmed ICU data — fall through to raw codes.
    namer = null;
  }
  cache.set(locale, namer);
  return namer;
}

/**
 * A `code → display name` resolver for one locale. Falls back to the code itself,
 * which is still meaningful ("DE" beats an empty cell).
 */
export function countryNamer(locale: string): (code: string) => string {
  const namer = namerFor(locale);
  return (code: string) => {
    if (!namer) return code;
    try {
      return namer.of(code) ?? code;
    } catch {
      return code;
    }
  };
}
