import { describe, expect, it } from "vitest";
import {
  compileEdgePages,
  normalizeEdgeHtml,
  normalizeEdgePages,
  normalizeProjectEdgePages,
  resolveProjectEdgePages,
  type EdgePages,
} from "./edge-pages";

const page = (html = "<h1>Unavailable</h1>"): EdgePages => ({
  files: [{ id: "error", name: "error.html", html }],
  errors: [{ status: 502, pageId: "error" }],
});

describe("edge HTML pages", () => {
  it("accepts literal scripts without converting them into executable configuration", () => {
    const html = `<script>const value = '$host';</script>\n' } error_page 200 /private; #`;
    expect(normalizeEdgePages(page(html)).files[0].html).toBe(html);
    expect(normalizeEdgeHtml("x".repeat(65536))).toHaveLength(65536);
    expect(() => normalizeEdgeHtml("é".repeat(32769))).toThrow("64 KiB");
    expect(() => normalizeEdgeHtml("\0")).toThrow();
  });
  it("rejects missing bindings, duplicate identifiers/statuses, unsupported errors and bad retry values", () => {
    const valid = page();
    for (const invalid of [
      { ...valid, files: [...valid.files, ...valid.files] },
      { ...valid, errors: [...valid.errors, ...valid.errors] },
      { ...valid, errors: [{ status: 502, pageId: "absent" }] },
      { ...valid, errors: [{ status: 401, pageId: "error" }] },
      { ...valid, maintenance: { enabled: true, retryAfter: 0 } },
      { ...valid, maintenance: { enabled: true, retryAfter: 300, pageId: "absent" } },
      { ...valid, defaultPageId: "error" },
    ])
      expect(() => normalizeEdgePages(invalid)).toThrow();
    expect(() =>
      normalizeEdgePages({ ...valid, maintenance: { enabled: true, retryAfter: 300 } }, "server"),
    ).toThrow();
  });
  it("merges host errors by status without collisions between independently named files", () => {
    const defaults = { ...page("project"), maintenance: { enabled: true, retryAfter: 300 } };
    const host = {
      ...page("host"),
      errors: [{ status: 503 as const, pageId: "error" }],
      maintenance: { enabled: false, retryAfter: 300 },
    };
    const config = normalizeProjectEdgePages({ defaults, hosts: { "site.test": host } });
    expect(resolveProjectEdgePages(config, "site.test")).toEqual({
      errors: { "502": "project", "503": "host" },
      maintenance: { enabled: false, retryAfter: 300 },
    });
    expect(resolveProjectEdgePages(config, "other.test")).toEqual(compileEdgePages(defaults));
    expect(resolveProjectEdgePages(undefined, "site.test")).toBeNull();
    // JSON sidecars must compare equal on read, including built-in maintenance.
    expect(JSON.parse(JSON.stringify(compileEdgePages(defaults)))).toEqual(
      compileEdgePages(defaults),
    );
  });
  it("bounds host names and aggregate storage", () => {
    for (const host of ["*.site.test", "SITE.test", "bad.test\n", "__proto__"])
      expect(() => normalizeProjectEdgePages({ hosts: { [host]: page() } })).toThrow();
    expect(() =>
      normalizeProjectEdgePages({
        hosts: Object.fromEntries(
          Array.from({ length: 40 }, (_, i) => [`site${i}.test`, page("x".repeat(65536))]),
        ),
      }),
    ).toThrow("2 MiB");
  });
});
