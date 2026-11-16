import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Guard on the repo-root `.dockerignore`: a pattern there can silently delete
 * application SOURCE from every published image, and nothing downstream notices
 * — `next build` inside the image happily compiles the truncated tree, the
 * manifest it emits agrees with it, and CI is green.
 *
 * GH-622 is the incident. v0.6.6 added `**\/build` for the webmail client's Vite
 * output; it also matched the dashboard's own `/build/[id]` route directory, so
 * openship-dashboard:0.6.6 shipped 52 routes where 0.6.5 had 53 and every
 * deployment-detail link 404'd. Only the published image was wrong, which is the
 * worst place for a bug to be visible for the first time.
 */

const REPO_ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

/** Port of moby/patternmatcher's pattern→regex conversion (BuildKit uses it for
 *  `.dockerignore`): `*` stops at a separator, `**` spans segments, `?` is one
 *  non-separator char. */
function toRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        i++;
        if (i + 1 >= pattern.length) {
          re += ".*";
        } else {
          if (pattern[i + 1] === "/") i++;
          re += "(?:.*/)?";
        }
      } else {
        re += "[^/]*";
      }
    } else if (ch === "?") re += "[^/]";
    else if (ch === "\\") re += "\\\\";
    else if (".$+()[]{}^|".includes(ch)) re += `\\${ch}`;
    else re += ch;
  }
  return new RegExp(`^${re}$`);
}

type Pattern = { raw: string; exception: boolean; re: RegExp };

function parsePatterns(lines: string[]): Pattern[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .map((raw) => {
      const exception = raw.startsWith("!");
      const cleaned = (exception ? raw.slice(1).trim() : raw)
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");
      return { raw, exception, re: toRegex(cleaned) };
    });
}

/** Docker excludes a file when a pattern matches it OR any of its ancestor
 *  directories — that containment rule is what turned `**\/build` into a source
 *  deletion. Last matching pattern wins, so a later `!` re-includes. */
function isExcluded(path: string, patterns: Pattern[]): boolean {
  const segments = path.split("/");
  const candidates = segments.map((_, i) => segments.slice(0, i + 1).join("/"));
  let excluded = false;
  for (const p of patterns) {
    if (candidates.some((c) => p.re.test(c))) excluded = !p.exception;
  }
  return excluded;
}

const patterns = parsePatterns(
  readFileSync(join(REPO_ROOT, ".dockerignore"), "utf8").split("\n"),
);

const tracked = execFileSync("git", ["ls-files", "-z"], {
  cwd: REPO_ROOT,
  encoding: "utf8",
  maxBuffer: 1 << 28,
})
  .split("\0")
  .filter(Boolean);

/** Dropped on purpose: no Dockerfile copies a `.env*` out of the context — every env
 *  COPY is `--from=builder` — so excluding them cannot break a build. Prose is NOT
 *  exempted here: `.dockerignore`'s `*.md` is unanchored and so drops only root-level
 *  files, and apps/web/Dockerfile compiles the 102 `.mdx` files under content/. */
const DELIBERATE = /(^|\/)\.env($|\.)/;
const contextFiles = tracked.filter((file) => !isExcluded(file, patterns));

/** Map repository files to their paths in the first dependency-install stage.
 * This deliberately handles only the COPY/WORKDIR syntax used by our images;
 * validating a manifest against the full checkout would miss absent build inputs.
 */
function dependencyInputs(dockerfile: string): Map<string, string> {
  let directory = "/";
  const files = new Map<string, string>();
  for (const line of dockerfile.replace(/\\\r?\n/g, " ").split("\n")) {
    const [instruction, ...args] = line.trim().split(/\s+/);
    if (instruction === "FROM") {
      directory = "/";
      files.clear();
    } else if (instruction === "WORKDIR") {
      directory = posix.resolve(directory, args[0]);
    } else if (instruction === "COPY" && !args.some((arg) => arg.startsWith("--from="))) {
      const parents = args.includes("--parents");
      const paths = args.filter((arg) => !arg.startsWith("--"));
      const destination = posix.resolve(directory, paths.pop()!);
      for (const source of paths) {
        const pattern = toRegex(source);
        const prefix = source.replace(/\/$/, "") + "/";
        for (const file of contextFiles) {
          if (pattern.test(file)) {
            files.set(posix.join(destination, parents ? file : posix.basename(file)), file);
          } else if (file.startsWith(prefix)) {
            files.set(posix.join(destination, file.slice(prefix.length)), file);
          }
        }
      }
    } else if (instruction === "RUN" && /\bbun install\b/.test(line)) {
      return files;
    }
  }
  throw new Error("No dependency installation found in Dockerfile");
}

describe("Docker dependency inputs", () => {
  it.each([
    "apps/api/Dockerfile",
    "apps/dashboard/Dockerfile",
    "apps/web/Dockerfile",
    "apps/email/Dockerfile.webmail",
  ])("resolves local package archives inside %s before installation", (path) => {
    const inputs = dependencyInputs(readFileSync(join(REPO_ROOT, path), "utf8"));
    let checked = 0;
    for (const [destination, source] of inputs) {
      if (!destination.endsWith("/package.json")) continue;
      const manifest = JSON.parse(readFileSync(join(REPO_ROOT, source), "utf8"));
      for (const dependency of Object.values({
        ...manifest.dependencies,
        ...manifest.devDependencies,
        ...manifest.optionalDependencies,
      })) {
        if (typeof dependency !== "string" || !dependency.startsWith("file:")) continue;
        const resolved = posix.resolve(posix.dirname(destination), dependency.slice(5));
        expect(
          inputs.has(resolved) || inputs.has(posix.join(resolved, "package.json")),
          `${destination}: missing ${resolved}`,
        ).toBe(true);
        checked++;
      }
      if (manifest.workspaces) {
        expect(inputs.get(posix.join(posix.dirname(destination), "bunfig.toml"))).toBe("bunfig.toml");
      }
      for (const patch of Object.values(manifest.patchedDependencies ?? {})) {
        if (typeof patch !== "string") continue;
        const resolved = posix.resolve(posix.dirname(destination), patch);
        expect(inputs.has(resolved), `${destination}: missing dependency patch ${resolved}`).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe(".dockerignore vs tracked source", () => {
  it("sees the repo (git ls-files returned files)", () => {
    expect(tracked.length).toBeGreaterThan(100);
  });

  it("keeps every tracked apps/ and packages/ source file in the build context", () => {
    const dropped = tracked.filter(
      (f) =>
        /^(apps|packages)\//.test(f) && !DELIBERATE.test(f) && isExcluded(f, patterns),
    );
    expect(dropped).toEqual([]);
  });

  // Pins the matcher itself against the real incident, so this file cannot pass by
  // being too lax about how Docker treats an excluded directory.
  it("reproduces GH-622: `**/build` swallows the /build/[id] route, the anchored pattern does not", () => {
    const route = "apps/dashboard/src/app/(dashboard)/(deployment)/build/[id]/page.tsx";
    expect(isExcluded(route, parsePatterns(["**/build"]))).toBe(true);
    expect(isExcluded(route, parsePatterns(["apps/email/client/build"]))).toBe(false);
    expect(
      isExcluded("apps/email/client/build/client/index.html", parsePatterns(["apps/email/client/build"])),
    ).toBe(true);
  });

  it("honours `!` exceptions and `**/` depth", () => {
    const p = parsePatterns(["**/.env", "**/.env.*", "!**/.env.example"]);
    expect(isExcluded("apps/api/.env", p)).toBe(true);
    expect(isExcluded("apps/api/.env.local", p)).toBe(true);
    expect(isExcluded("apps/api/.env.example", p)).toBe(false);
    expect(isExcluded("packages/platform/src/engine/config/env.ts", p)).toBe(false);
  });

  it("excludes generated mail credentials and keys but retains vendored dependencies", () => {
    for (const path of [
      "apps/email/.dev-mail/server.env",
      "apps/email/.dev-mail/tls/key.pem",
      "apps/email/.dev-mail/data/dovecot-keys/private.key",
    ]) {
      expect(isExcluded(path, patterns), path).toBe(true);
    }
    for (const path of tracked.filter((file) => file.startsWith("vendor/"))) {
      expect(isExcluded(path, patterns), path).toBe(false);
    }
  });
});
