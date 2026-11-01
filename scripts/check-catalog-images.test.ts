import { describe, expect, it } from "bun:test";
import { catalogBuildImages, catalogImages, checkCatalogImages } from "./check-catalog-images";

describe("catalog registry availability", () => {
  it("checks external build dependencies without treating local stages as registry images", () => {
    const dockerfile =
      "FROM --platform=$BUILDPLATFORM wordpress:7.1.3-php8.3-apache AS web\nCOPY --from=wordpress:cli-2.12.0-php8.3 /usr/local/bin/wp /usr/local/bin/wp\nFROM web AS final\nCOPY --from=0 /a /b\nFROM scratch\n";
    expect(catalogBuildImages(dockerfile)).toEqual([
      "wordpress:7.1.3-php8.3-apache",
      "wordpress:cli-2.12.0-php8.3",
    ]);
    expect([
      ...catalogImages([
        { id: "wp", available: true, services: [{ name: "wordpress", build: { dockerfile } }] },
      ]).keys(),
    ]).toEqual(catalogBuildImages(dockerfile));
  });
  it("checks every offered image once and excludes disabled/build-only apps", () => {
    const images = catalogImages(
      [
        {
          id: "app",
          available: true,
          services: [{ name: "db", image: "postgres:16" }, { name: "built" }],
        },
        { id: "disabled", available: false, services: [{ name: "db", image: "missing:1" }] },
      ],
      [
        { id: "postgres", image: "postgres:16" },
        { id: "storage", image: "storage@sha256:test" },
      ],
    );
    expect([...images]).toEqual([
      ["postgres:16", ["app/db", "library/postgres"]],
      ["storage@sha256:test", ["library/storage"]],
    ]);
  });

  it("reports failed registries without dropping other results or exceeding concurrency", async () => {
    let active = 0;
    let peak = 0;
    const visited: string[] = [];
    const images = new Map(Array.from({ length: 8 }, (_, i) => [String(i), ["app/" + i]]));
    const failures = await checkCatalogImages(images, async (image) => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(1);
      active--;
      visited.push(image);
      if (image === "3") throw new Error("manifest not found");
    });
    expect(visited.sort()).toEqual([...images.keys()]);
    expect(peak).toBeLessThanOrEqual(3);
    expect(failures).toEqual([{ image: "3", sources: ["app/3"] }]);
  });
});
