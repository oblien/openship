import { describe, expect, it } from "vitest";
import { extractChangelogSection, parseChangelog } from "../src/updates/changelog";

describe("shared changelog entries", () => {
  it.each(["1.2.3", "v1.2.3", "[1.2.3]", "[v1.2.3]"])(
    "reads a dated %s heading with exact version identity",
    (heading) => {
      expect(parseChangelog(`## ${heading} - 2026-09-16\r\n\r\nNotes.\r\n`)).toEqual([
        { version: "1.2.3", body: "Notes." },
      ]);
    },
  );

  it("keeps prereleases and build metadata distinct from a stable version", () => {
    const markdown = "## 1.2.3-rc.1+build.2\nRC notes\n## 1.2.3\nStable notes";
    expect(extractChangelogSection(markdown, "v1.2.3")).toBe("Stable notes");
    expect(extractChangelogSection(markdown, "v1.2.3-rc.1+build.2")).toBe("RC notes");
    expect(extractChangelogSection(markdown, "v1.2.3-rc.1")).toBe("");
  });

  it("does not absorb unversioned sections or malformed version tokens", () => {
    const markdown =
      "## 1.2.3\nRelease notes\n## Credits\nOther text\n## 1.2.30suffix\nBad version";
    expect(parseChangelog(markdown)).toEqual([{ version: "1.2.3", body: "Release notes" }]);
  });

  it.each(["```", "~~~~"])("ignores version headings inside a %s code fence", (fence) => {
    const body = `Example:\n${fence}md\n## 9.9.9\n### Example\n${fence}\n### Fixes\n- Correct.`;
    const markdown = `## 1.2.3\n${body}\n## 1.2.2\nOlder.`;
    expect(parseChangelog(markdown)).toEqual([
      { version: "1.2.3", body },
      { version: "1.2.2", body: "Older." },
    ]);
  });
});
