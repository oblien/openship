import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_TEMPLATES } from "@repo/core";
import { APP_LOGO } from "./AppLogo";

/**
 * Neither failure mode here is visible at runtime, which is how ClickHouse, code-server,
 * IT-Tools and Stirling PDF all shipped with no logo: a catalog app missing from APP_LOGO
 * silently renders the generic Boxes glyph, and a vendored `src` pointing at a file that
 * isn't there 404s into the same fallback via the <img> onError. Both are asserted instead.
 *
 * A dead REMOTE slug (simpleicons deleted `nocodb`) can't be caught without the network —
 * that's the standing argument for vendoring a brand mark over resolving one from a CDN.
 */
describe("APP_LOGO", () => {
  it("has an entry for every catalog app", () => {
    const missing = APP_TEMPLATES.filter((t) => !APP_LOGO[t.id]).map((t) => t.id);
    expect(missing).toEqual([]);
  });

  it("resolves every vendored src to a file under public/", () => {
    const local = Object.entries(APP_LOGO).flatMap(([id, cfg]) =>
      cfg.src?.startsWith("/") ? [[id, cfg.src] as const] : [],
    );
    expect(local.length).toBeGreaterThan(0);
    for (const [id, src] of local) {
      const path = fileURLToPath(new URL(`../../public${src}`, import.meta.url));
      expect(existsSync(path), `${id} → ${src}`).toBe(true);
    }
  });
});
