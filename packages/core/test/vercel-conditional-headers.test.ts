import { describe, expect, it } from "vitest";

import { parseVercelConfig } from "../src/metadata/vercel";

// Vercel's `headers` rules — like `redirects` and `rewrites` — support `has` and
// `missing` conditions (match only when a header/cookie/host/query is present or
// absent). openship reproduces routing with plain nginx locations, which can't
// express those conditions, so a conditional rule must be DROPPED. Applying its
// headers anyway would set them on EVERY request, not just the matching ones.
//
// parseRewrites/parseRedirects already skip conditional entries; parseHeaders did
// not, so a `has`/`missing` header rule leaked through and was later emitted as an
// unconditional `add_header … always;`.

describe("vercel.json conditional header rules", () => {
  it("drops a `has`-conditioned header rule", () => {
    const cfg = parseVercelConfig(
      JSON.stringify({
        headers: [
          {
            source: "/(.*)",
            has: [{ type: "host", value: "admin.example.com" }],
            headers: [{ key: "X-Admin", value: "1" }],
          },
        ],
      }),
    );
    // No unconditional-safe header rules remain → `headers` is absent entirely.
    expect(cfg?.headers).toBeUndefined();
  });

  it("drops a `missing`-conditioned header rule", () => {
    const cfg = parseVercelConfig(
      JSON.stringify({
        headers: [
          {
            source: "/(.*)",
            missing: [{ type: "cookie", key: "session" }],
            headers: [{ key: "X-Anon", value: "1" }],
          },
        ],
      }),
    );
    expect(cfg?.headers).toBeUndefined();
  });

  it("keeps an unconditional header rule and drops the conditional one alongside it", () => {
    const cfg = parseVercelConfig(
      JSON.stringify({
        headers: [
          {
            source: "/(.*)",
            has: [{ type: "query", key: "authorized" }],
            headers: [{ key: "X-Authorized", value: "true" }],
          },
          {
            source: "/assets/(.*)",
            headers: [{ key: "Cache-Control", value: "public, max-age=31536000" }],
          },
        ],
      }),
    );
    expect(cfg?.headers).toEqual([
      {
        source: "/assets/(.*)",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000" }],
      },
    ]);
  });
});
