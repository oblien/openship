import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A moved project must arrive with the certificates it already had.
 *
 * `carrySourceCerts` plants the source's TLS material at the target's certbot path before the
 * post-verify domain publish reads it, so a kept domain reuses its cert instead of re-issuing.
 * For a project MOVE it did nothing, and the symptom looked like a completely different bug:
 * every domain re-issued through ACME on the target, failed while DNS still pointed at the
 * source, and the operator got "Domain routed without HTTPS" plus three pages of certbot output
 * on a stack whose five services had all started cleanly.
 *
 * The cause was the domain SOURCE. `chosen[].existingRoute` comes from the foreign-proxy scan —
 * another box's nginx/caddy/traefik config, indexed by published host port. Right for adopting a
 * stranger's stack; empty for a project we own, whose domains are in our own `domain` table and
 * whose containers publish on loopback ports.
 */
const src = readFileSync(new URL("./migration.orchestrator.ts", import.meta.url), "utf8");
const carry = (() => {
  const from = src.indexOf("  private async carrySourceCerts(");
  return src.slice(from, src.indexOf("\n  private async ", from + 10));
})();
/** Comments stripped. Asserting absence against raw source fails on the comment that explains
 *  the absence — a note about `sslStatus` is not a use of it. */
const carryCode = carry.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("cert carry reads the project's own domains", () => {
  it("takes a projectId", () => {
    expect(carry).toContain("projectId?: string");
  });

  it("adds every hostname the project owns", () => {
    expect(carry).toContain("repos.domain.listByProject(projectId)");
    expect(carry).toContain("domains.add(row.hostname.toLowerCase())");
  });

  it("still reads the scan's routes too, so adopting a stranger's stack is unchanged", () => {
    expect(carry).toContain("s.existingRoute ?? []");
  });

  it("does NOT pre-filter on our own sslStatus", () => {
    // `certCandidateFor` already verifies coverage + expiry and skips with a reason. A second
    // opinion here — from a column that can be stale — would silently drop a domain that had a
    // perfectly good cert, sending it back through ACME.
    expect(carryCode).not.toContain("sslStatus");
  });

  it("survives a project whose domains can't be read", () => {
    expect(carry).toContain("listByProject(projectId).catch(() => [])");
  });
});

describe("the run passes the project only for a project move", () => {
  it("hands projectId in for a move/copy and undefined for a scan adopt", () => {
    // Door A adopts a stranger's containers into a NEW project that owns no domains yet, so
    // passing its id would add nothing and imply a relationship that doesn't exist.
    const call = src.slice(src.indexOf("await this.carrySourceCerts("));
    expect(call.slice(0, 700)).toContain("input.projectMove ? projectId : undefined");
  });

  it("still only carries cross-server", () => {
    // Same-server has nothing to move: it is the same certbot directory.
    expect(src).toContain("if (!sameServer) {");
  });

  it("never fails the migration on a carry error", () => {
    const call = src.slice(src.indexOf("await this.carrySourceCerts("));
    expect(call.slice(0, 700)).toContain("cert carry skipped");
  });
});
