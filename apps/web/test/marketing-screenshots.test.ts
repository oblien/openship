import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { APP_LOCALES } from "@repo/core/locale";
import { localizedScreenshot, WALKTHROUGH_STAGES } from "../src/lib/marketing-screenshots";

const asset = (path: string) => readFileSync(new URL(`../public${path}`, import.meta.url));

describe("localized product screenshots", () => {
  test("every supported language has real hero and walkthrough image files", () => {
    const english = asset(localizedScreenshot("/screen.png", "en"));
    for (const locale of APP_LOCALES) {
      const paths = [
        localizedScreenshot("/screen.png", locale),
        ...WALKTHROUGH_STAGES.flatMap((stage) => [
          localizedScreenshot(`/walkthrough/${stage}.jpg`, locale),
          localizedScreenshot(`/walkthrough/${stage}-light.jpg`, locale),
        ]),
      ];
      for (const path of paths) {
        expect(path).toStartWith(`/screenshots/${locale}/`);
        const image = asset(path);
        expect(image.toString("ascii", 0, 4)).toBe("RIFF");
        expect(image.toString("ascii", 8, 12)).toBe("WEBP");
        expect(image.length).toBeGreaterThan(1000);
      }
      if (locale !== "en") {
        expect(asset(paths[0]).equals(english)).toBe(false);
        const readme = readFileSync(
          new URL(`../../../docs/i18n/README.${locale}.md`, import.meta.url),
          "utf8",
        );
        expect(readme).toContain(`src="../../apps/web/public${paths[0]}"`);
      }
    }
  });

  test("the repository screenshot matches the refreshed English PNG", () => {
    const web = asset("/screen.png");
    const docs = readFileSync(new URL("../../../docs/screenshots/screen.png", import.meta.url));
    expect(web.equals(docs)).toBe(true);
    expect(web.readUInt32BE(16)).toBe(2998);
    expect(web.readUInt32BE(20)).toBe(1572);
  });

  test("other product images keep their original assets", () => {
    for (const path of ["/email-preview.png", "/walkthrough/unknown.jpg", "/logo.svg"])
      expect(localizedScreenshot(path, "ar")).toBe(path);
  });
});
