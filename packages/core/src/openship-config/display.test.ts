import { describe, expect, it } from "vitest";
import { parseOpenshipConfig } from "./parse";
import { openshipMetadataParser } from "../metadata/openship";

describe("openship.json public display metadata", () => {
  it("normalizes optional branding alongside the existing deployment fields", () => {
    const result = parseOpenshipConfig({
      display: { name: "  My app  ", logo: "./public/brand/logo.svg", ignored: "value" },
      framework: "nextjs",
      port: 3000,
      env: { TOKEN: { value: "secret", secret: true } },
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.config).toEqual({
      display: { name: "My app", logo: "public/brand/logo.svg" },
      framework: "nextjs",
      port: 3000,
      env: { TOKEN: { value: "secret", secret: true } },
    });
  });

  it.each([undefined, {}])("does not add display fields for %j", (display) => {
    expect(parseOpenshipConfig({ display, port: 8080 })).toEqual({
      config: { port: 8080 },
      errors: [],
      warnings: [],
    });
  });

  it.each(["logo.PNG", "logo.jpeg", "brand/logo.webp", "public/شعار app.svg"])(
    "accepts a repository image at %s",
    (logo) => {
      const result = parseOpenshipConfig({ display: { logo } });
      expect(result.errors).toEqual([]);
      expect(result.config?.display).toEqual({ logo });
    },
  );

  it.each([
    "https://example.com/logo.svg",
    "//example.com/logo.svg",
    "/logo.svg",
    "../logo.svg",
    "public/../../logo.svg",
    "public/../logo.svg",
    "public/%2e%2e/logo.svg",
    "data:image/svg+xml,<svg/>",
    "javascript:logo.svg",
    "public\\logo.svg",
    "logo.svg?x=1",
    "logo.svg#x",
    "logo\n.svg",
    "logo\u202e.svg",
    "logo.html",
    "logo.svg.html",
    "<svg/>",
    "",
    `${"x".repeat(509)}.png`,
  ])("rejects an unsafe or unsupported logo path %j", (logo) => {
    const result = parseOpenshipConfig({
      display: { name: "My app", logo },
      framework: "nextjs",
      port: 3000,
    });
    expect(result.errors).toEqual([expect.stringMatching(/^display\.logo:/)]);
    // A bad presentation field cannot erase valid deployment settings or the name.
    expect(result.config).toEqual({ display: { name: "My app" }, framework: "nextjs", port: 3000 });
  });

  it.each(["", "  ", "name\n", "\tname", "name\u0000", "name\u202e", "x".repeat(81)])(
    "rejects invalid names %j while retaining a valid logo",
    (name) => {
      const result = parseOpenshipConfig({ display: { name, logo: "logo.png" } });
      expect(result.errors).toEqual([expect.stringMatching(/^display\.name:/)]);
      expect(result.config?.display).toEqual({ logo: "logo.png" });
    },
  );

  it.each([null, false, [], "name"])("rejects a non-object display value %j", (display) => {
    expect(parseOpenshipConfig({ display }).errors).toEqual(["display: must be an object"]);
  });

  it("rejects non-string fields", () => {
    expect(parseOpenshipConfig({ display: { name: {}, logo: 42 } }).errors).toEqual([
      "display.name: must be a string",
      "display.logo: must be a string",
    ]);
  });

  it("does not introduce build detection signal or alter deployment metadata", () => {
    const display = { name: "My app", logo: "logo.svg" };
    expect(
      openshipMetadataParser.parse({ "openship.json": JSON.stringify({ display }) }),
    ).toBeNull();
    const build = { framework: "nextjs", buildCommand: "bun run build" };
    expect(
      openshipMetadataParser.parse({ "openship.json": JSON.stringify({ ...build, display }) }),
    ).toEqual(openshipMetadataParser.parse({ "openship.json": JSON.stringify(build) }));
  });
});
