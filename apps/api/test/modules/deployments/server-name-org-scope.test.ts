import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A server id that reaches these three files is CLIENT-SUPPLIED. It arrives in the
 * deploy body (`deployment.schema.ts` accepts `serverId`), `resolveSnapshotTarget`
 * gives that override top priority with no org check, and the deployment row is
 * persisted with it BEFORE the target is validated — so a deploy that fails on
 * "not in this organization" still leaves a row whose `meta.serverId` names a
 * foreign server.
 *
 * Reading that id with the UNSCOPED `repos.server.get` and projecting the result
 * turns each of these into a cross-tenant oracle: post a deploy naming another
 * org's server uuid, then read your own build status back and get its name or SSH
 * host. That is precisely what the docblock on `resolveOrgServer`
 * (`lib/deployment-runtime.ts`) was written to prevent, and it was defeated by
 * neighbours that never got the memo.
 *
 * Scanned from source rather than exercised through the functions, for the reason
 * `deployment-status.test.ts` already gives: each of these lives inside a
 * projection that would need heavy mocking (`loadDeployment`, the session manager,
 * route state) to reach, and the invariant is a one-line call-shape that source
 * pins exactly as well.
 *
 * If one of these is legitimately refactored, update its entry — do not delete it.
 * A removed entry is how the guard rots into a vacuous pass.
 */

const REPO_ROOT = join(__dirname, "..", "..", "..", "..", "..");

const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), "utf8");

/** Comments stripped, so prose that merely NAMES the unscoped call can't trip the
 *  negative assertions below (these files explain the gate in their comments). */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/** Every projection that resolves a client-supplied server id for display. */
const ORG_SCOPED_LOOKUPS: Array<{
  what: string;
  file: string;
  /** The org id the lookup must be scoped by. */
  orgArg: string;
  breaks: string;
}> = [
  {
    what: "build status → serverName",
    file: "apps/api/src/modules/deployments/build-status.service.ts",
    orgArg: "dep.organizationId",
    breaks:
      "GET build status leaks a foreign org's server name/sshHost for any serverId posted in a deploy body",
  },
  {
    what: "project enrichment → serverName",
    file: "apps/api/src/modules/projects/project-crud.service.ts",
    orgArg: "p.organizationId",
    breaks: "the project projection leaks a foreign org's server name/sshHost",
  },
];

describe("client-supplied server ids are resolved org-scoped", () => {
  for (const { what, file, orgArg, breaks } of ORG_SCOPED_LOOKUPS) {
    it(`${what} uses getInOrganization (else: ${breaks})`, () => {
      const src = code(read(file));
      expect(src).toContain("getInOrganization");
      expect(src).toContain(orgArg);
      // The unscoped variant must not appear at all in these files. `.get(` on its
      // own is far too common to match, so anchor on the repo call shape.
      expect(src).not.toMatch(/repos\s*\.\s*server\s*\.\s*get\s*\(/);
    });
  }

  it("reconcile org-checks the snapshot serverId BEFORE probing it", () => {
    const file = "apps/api/src/modules/deployments/reconcile.service.ts";
    const src = code(read(file));

    const guardAt = src.indexOf("getInOrganization");
    const probeAt = src.indexOf("probe.isReachable");

    expect(guardAt, "reconcile.service.ts no longer org-checks the serverId").toBeGreaterThan(-1);
    expect(probeAt, "the reachability probe moved — re-anchor this guard").toBeGreaterThan(-1);
    // Ordering, not mere presence: a check that runs after the dial has already
    // aimed a TCP connection at another org's host.
    expect(guardAt).toBeLessThan(probeAt);
    expect(src).not.toMatch(/repos\s*\.\s*server\s*\.\s*get\s*\(/);
  });
});
