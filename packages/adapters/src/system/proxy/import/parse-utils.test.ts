import { describe, expect, it } from "vitest";
import { collapseByHost, extractBlocks, stripComments } from "./parse-utils";

/**
 * The regression these exist for: `stripComments` was `/#.*$/gm`, and the edge's
 * not-found page (#431) put a CSS `#fff` inside a `return 404 '…'` token. The line
 * was cut mid-page, ~40 closing braces went with it, and because the edge scan cats
 * every vhost into ONE string with `_default.conf` first, `extractBlocks` swallowed
 * every server block after it. The box scanned as zero sites — no domains offered by
 * the migrate wizard, no certificates carried at cutover — and nothing failed.
 */
describe("stripComments", () => {
  it("strips a whole-line and a trailing comment", () => {
    expect(stripComments("# header\nlisten 80; # trailing\n")).toBe("\nlisten 80; \n");
  });

  it("keeps a # that lives inside a quoted token", () => {
    const line = `return 404 'body{background:#fff}footer{color:#0a0a0a}';`;
    expect(stripComments(line)).toBe(line);
  });

  it("still strips the comment that FOLLOWS a quoted token", () => {
    expect(stripComments(`add_header X-A "a#b"; # note`)).toBe(`add_header X-A "a#b"; `);
  });

  it("keeps the braces of a quoted body balanced, so blocks still parse", () => {
    const conf = [
      "server {",
      "  location / {",
      `    return 404 'a{b}c#d{e}f';`,
      "  }",
      "}",
    ].join("\n");
    const stripped = stripComments(conf);
    expect(extractBlocks(stripped, "server")).toHaveLength(1);
    expect(extractBlocks(stripped, "location")).toHaveLength(1);
  });

  it("resets quote state at each newline, so one stray quote costs one line", () => {
    // A config that opens a quote and never closes it must not turn the rest of the
    // file into "string" — that would delete every comment-bearing line after it.
    const out = stripComments(`add_header X "unclosed\nlisten 80; # gone\n`);
    expect(out).toContain("listen 80; ");
    expect(out).not.toContain("# gone");
  });

  it("does not treat an apostrophe in a comment as opening a string", () => {
    expect(stripComments("listen 80; # don't cut the next line\nserver_name a.com;")).toBe(
      "listen 80; \nserver_name a.com;",
    );
  });
});

/**
 * `collapseByHost` is the shared same-hostname dedup every importer (nginx,
 * traefik, caddy, apache) funnels through. A wrong winner here is what took a
 * customer's HTTPS site down to plain HTTP, so pin the invariants directly
 * rather than only through the per-proxy importer tests.
 */
describe("collapseByHost", () => {
  const hosts = (h: string[]) => h;

  it("keeps every block when no two share a host set", () => {
    const items = [
      { id: "a", h: ["a.com"], s: 1 },
      { id: "b", h: ["b.com"], s: 1 },
    ];
    const { kept, dropped } = collapseByHost(
      items,
      (i) => i.h,
      (i) => i.s,
    );
    expect(kept.map((i) => i.id)).toEqual(["a", "b"]);
    expect(dropped).toEqual([]);
  });

  it("keeps the highest score and drops the loser for a colliding host", () => {
    const http = { id: "http", h: ["site.com"], s: 0 };
    const https = { id: "https", h: ["site.com"], s: 2 };
    const { kept, dropped } = collapseByHost(
      [http, https],
      (i) => i.h,
      (i) => i.s,
    );
    expect(kept.map((i) => i.id)).toEqual(["https"]);
    expect(dropped.map((i) => i.id)).toEqual(["http"]);
  });

  it("keeps the FIRST on a score tie (source order)", () => {
    const first = { id: "first", h: ["site.com"], s: 1 };
    const second = { id: "second", h: ["site.com"], s: 1 };
    const { kept, dropped } = collapseByHost(
      [first, second],
      (i) => i.h,
      (i) => i.s,
    );
    expect(kept.map((i) => i.id)).toEqual(["first"]);
    expect(dropped.map((i) => i.id)).toEqual(["second"]);
  });

  it("treats a multi-name block as its own group, not merged per-name", () => {
    const multi = { id: "multi", h: ["a.com", "b.com"], s: 5 };
    const single = { id: "single", h: ["a.com"], s: 9 };
    const { kept, dropped } = collapseByHost(
      [multi, single],
      (i) => i.h,
      (i) => i.s,
    );
    // Different host SETS → different groups → both kept, despite sharing a.com.
    expect(kept.map((i) => i.id).sort()).toEqual(["multi", "single"]);
    expect(dropped).toEqual([]);
  });

  it("is order-insensitive to how the names within a block are listed", () => {
    const ab = { id: "ab", h: ["a.com", "b.com"], s: 1 };
    const ba = { id: "ba", h: ["b.com", "a.com"], s: 2 };
    const { kept } = collapseByHost(
      [ab, ba],
      (i) => i.h,
      (i) => i.s,
    );
    expect(kept.map((i) => i.id)).toEqual(["ba"]); // same group, higher score wins
  });

  it("keeps groups in first-seen source order", () => {
    const items = [
      { id: "z", h: ["z.com"], s: 1 },
      { id: "a", h: ["a.com"], s: 1 },
      { id: "z2", h: ["z.com"], s: 0 },
    ];
    const { kept } = collapseByHost(
      items,
      (i) => i.h,
      (i) => i.s,
    );
    expect(kept.map((i) => i.id)).toEqual(["z", "a"]); // z group seen first
  });

  describe("traefik redirect-only semantics via score", () => {
    // Mirrors the folded-in traefik winner rule: redirectOnly → 0, else ssl?2:1.
    const score = (c: { redirectOnly: boolean; ssl: boolean }) =>
      c.redirectOnly ? 0 : c.ssl ? 2 : 1;

    it("a real TLS router beats the http→https redirect half", () => {
      const redirect = { id: "redir", h: ["x.com"], redirectOnly: true, ssl: false };
      const tls = { id: "tls", h: ["x.com"], redirectOnly: false, ssl: true };
      const { kept, dropped } = collapseByHost([redirect, tls], (c) => c.h, score);
      expect(kept.map((c) => c.id)).toEqual(["tls"]);
      expect(dropped.map((c) => c.id)).toEqual(["redir"]);
    });

    it("an all-redirect group keeps the first by source order, ignoring ssl", () => {
      // Both redirect-only → flat 0 → tie → first kept (NOT the ssl one).
      const r1 = { id: "r1", h: ["y.com"], redirectOnly: true, ssl: false };
      const r2 = { id: "r2", h: ["y.com"], redirectOnly: true, ssl: true };
      const { kept, dropped } = collapseByHost([r1, r2], (c) => c.h, score);
      expect(kept.map((c) => c.id)).toEqual(["r1"]);
      expect(dropped.map((c) => c.id)).toEqual(["r2"]);
    });
  });
});
