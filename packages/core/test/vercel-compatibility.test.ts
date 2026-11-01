import { describe, expect, it } from "vitest";
import { vercelCompatibilityWarnings, parseVercelConfig } from "../src/metadata/vercel";
describe("Vercel compatibility diagnostics", () => {
  it("reports unsupported conditional rules without leaking their values or applying them unconditionally", () => {
    const raw = JSON.stringify({
      rewrites: [
        {
          source: "/private",
          destination: "/secret",
          has: [{ type: "header", value: "secret-value" }],
        },
      ],
      functions: { "secret-path": { memory: 1024 } },
    });
    const warnings = vercelCompatibilityWarnings(raw);
    expect(warnings).toHaveLength(2);
    expect(warnings.join(" ")).toContain("conditional has/missing");
    expect(warnings.join(" ")).not.toContain("secret");
    expect(parseVercelConfig(raw)?.rewrites).toBeUndefined();
  });
  it("accepts the supported routing and build subset", () => {
    expect(
      vercelCompatibilityWarnings(
        JSON.stringify({
          buildCommand: "npm run build",
          outputDirectory: "dist",
          rewrites: [{ source: "/:path*", destination: "/index.html" }],
          cleanUrls: true,
        }),
      ),
    ).toEqual([]);
  });
  it("reports additional directives without echoing unknown keys", () => {
    const warnings = vercelCompatibilityWarnings(
      JSON.stringify({ "private-unknown-key": "secret-value" }),
    );
    expect(warnings).toEqual([
      "vercel.json contains additional directives that Openship does not implement.",
    ]);
  });
  it.each(["null", "[]", "{bad-json"])("reports an invalid configuration: %s", (raw) =>
    expect(vercelCompatibilityWarnings(raw)).toHaveLength(1),
  );
});
