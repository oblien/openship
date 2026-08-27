import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Regression suite for GHSA-43hf-p5j8-8vhx.
 *
 * `middleware/instance-admin.ts` already had thorough coverage — the gate itself
 * was never broken. What went wrong is that ONE route forgot to mount it:
 * `PATCH /api/system/settings` carried only `tag: "settings:write"`, and
 * `resourceTypeAllowedForRole` (lib/permission.ts) admits a plain `member` to
 * every resource type but billing/audit. So a member could write the single
 * global instance_settings row — repoint tunnelProvider/tunnelToken, shrink
 * every org's defaultRollbackWindow, flip defaultBuildMode, and on a box with
 * OPENSHIP_ALLOW_ZERO_AUTH=true, change authMode.
 *
 * Unit-testing the middleware could not catch that, so this suite asserts over
 * the route MANIFEST instead: every instance-global route must have
 * `requireInstanceAdmin()` mounted. Add a route that writes instance-wide state
 * and it belongs in INSTANCE_GLOBAL below.
 *
 * Note requireRole("owner") is NOT an acceptable substitute — it resolves a
 * caller-selected org and every user owns their personal org
 * (GHSA-rwq6-r63g-3c8h). See test/middleware/instance-admin.test.ts.
 */

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Comments are stripped so a commented-out gate can never satisfy an assertion. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const ROUTE_START = /\br\.(get|post|put|patch|delete|public)\s*\(/g;

/**
 * Slice the routes file into one chunk per `r.*()` registration. Chunks run to
 * the start of the next registration, which keeps multi-line calls intact
 * without needing to balance parens.
 */
function routeChunks(src: string): string[] {
  const clean = stripComments(src);
  const starts = [...clean.matchAll(ROUTE_START)].map((m) => m.index!);

  return starts.map((start, i) => clean.slice(start, starts[i + 1] ?? clean.length));
}

/** The chunk registering `path`, or undefined. `r.public` puts the method first. */
function chunkFor(chunks: string[], method: string, path: string): string | undefined {
  return chunks.find((chunk) => {
    if (!chunk.includes(`"${path}"`)) return false;
    const isPublic = chunk.startsWith("r.public");
    const declared = isPublic
      ? new RegExp(`^r\\.public\\s*\\(\\s*"${method}"\\s*,\\s*"${path}"`)
      : new RegExp(`^r\\.${method}\\s*\\(\\s*"${path}"`);
    return declared.test(chunk);
  });
}

/**
 * Routes whose handler writes or reads state spanning the WHOLE instance, not
 * one organization. `PATCH /settings` is the advisory; the rest were already
 * gated and are pinned here so they stay that way.
 */
const INSTANCE_GLOBAL: Array<[string, string]> = [
  ["patch", "/settings"],
  ["delete", "/settings"],
  ["put", "/settings/email"],
  ["post", "/settings/email/test"],
  // Both halves: the scan reads every org's domains, so the READ is instance-wide
  // too — gating only the write left a cross-tenant hostname enumeration open.
  ["get", "/edge/untracked"],
  ["post", "/edge/untracked/remove"],
  ["post", "/migration/preflight"],
  ["post", "/migration/start"],
  ["post", "/migration/start-cloud"],
  ["post", "/migration/start-tunnel"],
  ["post", "/migration/switch-back"],
  ["get", "/data-transfer/preview"],
  ["post", "/data-transfer/direct/session"],
  ["post", "/data-transfer/direct/send"],
  ["post", "/data-transfer/export"],
  ["post", "/data-transfer/import"],
];

describe("instance-global routes are gated by requireInstanceAdmin()", () => {
  const chunks = routeChunks(read("../../../src/modules/system/system.routes.ts"));

  it("parsed the routes file", () => {
    expect(chunks.length).toBeGreaterThan(20);
  });

  for (const [method, path] of INSTANCE_GLOBAL) {
    it(`${method.toUpperCase()} ${path} mounts requireInstanceAdmin()`, () => {
      const chunk = chunkFor(chunks, method, path);

      expect(chunk, `no registration found for ${method.toUpperCase()} ${path}`).toBeDefined();
      expect(
        chunk!.includes("requireInstanceAdmin()"),
        `${method.toUpperCase()} ${path} writes instance-wide state but has no instance gate`,
      ).toBe(true);
    });
  }

  // An org-scoped role check on an instance-global route reads as a gate and is
  // not one — that was the whole of GHSA-rwq6-r63g-3c8h.
  for (const [method, path] of INSTANCE_GLOBAL) {
    it(`${method.toUpperCase()} ${path} does not rely on requireRole()`, () => {
      expect(chunkFor(chunks, method, path)!.includes("requireRole(")).toBe(false);
    });
  }
});

describe("updateSettings — handler-level backstop", () => {
  const src = stripComments(read("../../../src/modules/system/setup.controller.ts"));
  const handler = src.slice(src.indexOf("export async function updateSettings"));
  const body = handler.slice(0, handler.indexOf("\nexport "));

  it("asserts instance-admin before reading the body", () => {
    expect(body).toContain("assertInstanceAdmin");
    expect(body.indexOf("assertInstanceAdmin")).toBeLessThan(body.indexOf("c.req.json"));
  });

  it("still writes only the global instance_settings row", () => {
    // If this ever becomes org-scoped the gate can relax; until then it can't.
    expect(body).toContain("instanceSettings.upsert");
  });
});

describe("GET /settings does not leak instance secrets to a reader", () => {
  const src = stripComments(read("../../../src/modules/system/setup.controller.ts"));
  const handler = src.slice(src.indexOf("export async function getSetup"));
  const body = handler.slice(0, handler.indexOf("\nexport "));

  // getSetup is settings:read (a member passes) so the tunnel token must not be
  // in the response — a member may now be unable to WRITE it, but echoing it
  // back would hand them the credential anyway.
  it("omits tunnelToken while still reporting tunnelProvider", () => {
    expect(body).not.toContain("tunnelToken");
    expect(body).toContain("tunnelProvider");
  });
});
