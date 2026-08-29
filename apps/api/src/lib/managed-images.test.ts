import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { devSourceTag } from "./managed-images";

const roots: string[] = [];
function makeComponent(files: Record<string, string>): { context: string; subdir: string } {
  const context = mkdtempSync(join(tmpdir(), "opsh-devtag-"));
  roots.push(context);
  const subdir = "comp";
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(context, subdir, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return { context, subdir };
}

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe("devSourceTag", () => {
  it("returns undefined when the component tree is absent/empty", () => {
    expect(devSourceTag("1.0.0", "/no/such/checkout", "apps/edge")).toBeUndefined();
  });

  it("produces `<base>-dev.<12 hex>` for a tree with source files", () => {
    const { context, subdir } = makeComponent({ "Dockerfile": "FROM x", "a.conf": "listen 80;" });
    expect(devSourceTag("0.5.0", context, subdir)).toMatch(/^0\.5\.0-dev\.[0-9a-f]{12}$/);
  });

  it("is stable for an unchanged tree", () => {
    const { context, subdir } = makeComponent({ "Dockerfile": "FROM x", "nested/b.lua": "return 1" });
    const first = devSourceTag("9.9.9", context, subdir);
    expect(first).toBeDefined();
    // An untouched tree keeps its tag, so the drift scan doesn't flap between runs.
    expect(devSourceTag("9.9.9", context, subdir)).toBe(first);
  });

  it("moves when the tree gains a file", () => {
    const base = makeComponent({ "Dockerfile": "FROM x" });
    const more = makeComponent({ "Dockerfile": "FROM x", "extra.conf": "server {}" });
    expect(devSourceTag("2.0.0", base.context, base.subdir)).not.toBe(
      devSourceTag("2.0.0", more.context, more.subdir),
    );
  });
});
