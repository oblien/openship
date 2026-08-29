import { describe, it, expect, vi } from "vitest";
import type { Context } from "hono";
import type { RequestContext } from "../../src/lib/request-context";

/**
 * WHERE THE ORG COMES FROM, per entry point.
 *
 * Two functions resolve the org for a check with no resource to resolve (list scope,
 * or an org-singleton at `resourceId: "*"`), and they must NOT use the same source:
 *
 *   assert                     → ESTABLISHES scope from `X-Organization-Id`, then
 *                                rebinds ctx.organizationId to what it resolved.
 *   checkPermissionOnResource  → CONSUMES that scope: `ctx.organizationId`.
 *
 * Both read the header once, and that made them look interchangeable. They are not.
 * Every caller of `checkPermissionOnResource` runs after routePermission's `assert`,
 * and reads its DATA from `ctx.organizationId` — so taking the org from the header
 * gates one org's authority over another org's work. Two live consequences:
 *
 *   - `canRunJob` on `GET /projects/:id/incoming-webhooks` (tag `project:read`, so
 *     assert resolved the PROJECT's org and rebound ctx). Its `{job,"*",write}` check
 *     went to the header instead, so a caller who is `restricted` in the project's
 *     org — with a project grant and no job grant — passed it on plain membership in
 *     any other org, and the handler revealed the hook's job-trigger secret.
 *   - Token minting, where the binding is written to `ctx.organizationId`:
 *     GHSA-qv27-39pc-qw9f finding 1 (covered end-to-end in
 *     modules/tokens/mint-org-binding.test.ts).
 *
 * Asserted in both directions: the header must not supply authority to
 * `checkPermissionOnResource`, and `assert` must still honour it or org switching
 * breaks for every list and singleton route.
 */

const HEADER_ORG = "orgA"; // u1 is a member here — and controls the header
const CTX_ORG = "orgB"; // what assert resolved for this request

vi.mock("@repo/db", () => ({
  repos: {
    member: {
      find: vi.fn(async (orgId: string, userId: string) => {
        if (userId !== "u1") return null;
        // A plain member of orgA; NOT a member of orgB at all, so any check that
        // lands on orgB fails outright and the org it used is unambiguous.
        return orgId === "orgA" ? { id: "mA", role: "member" } : null;
      }),
    },
    resourceGrant: { findForResource: vi.fn(async () => null), listByMember: vi.fn(async () => []) },
    patGrant: { findForResource: vi.fn(async () => null), listByToken: vi.fn(async () => []) },
    project: { findById: vi.fn(async () => null), findEnvVarById: vi.fn(async () => null) },
    server: { get: vi.fn(async () => null) },
    backupDestination: { findById: vi.fn(async () => null) },
    deployment: { findById: vi.fn(async () => null), findBuildSession: vi.fn(async () => null) },
    domain: { findById: vi.fn(async () => null) },
    service: { findById: vi.fn(async () => null) },
    backupPolicy: { findById: vi.fn(async () => null) },
    backupRun: { findById: vi.fn(async () => null) },
    backupRestore: { findById: vi.fn(async () => null) },
  },
}));
vi.mock("../../src/config/env", () => ({ env: { CLOUD_MODE: false } }));

import { assert, checkPermissionOnResource } from "../../src/lib/permission";

/** A ctx whose org has already been rebound away from the header, as assert does. */
function ctxFor(opts: { header: string | undefined; org: string }): RequestContext {
  const c = {
    req: {
      header: (n: string) =>
        n.toLowerCase() === "x-organization-id" ? opts.header : undefined,
    },
    get: () => undefined,
    set: () => {},
    var: {},
  } as unknown as Context;
  return { userId: "u1", organizationId: opts.org, hono: c } as unknown as RequestContext;
}

const JOB_WRITE = { resourceType: "job" as const, resourceId: "*", action: "write" as const };

describe("checkPermissionOnResource takes the org from ctx, not the header", () => {
  it("does not authorize an org-singleton from the header's org", async () => {
    // Header names the org u1 is a member of; ctx names the org they are not.
    // Header-sourced → member of orgA → true. ctx-sourced → not in orgB → false.
    const allowed = await checkPermissionOnResource(
      ctxFor({ header: HEADER_ORG, org: CTX_ORG }),
      JOB_WRITE,
    );
    expect(allowed).toBe(false);
  });

  it("does not authorize a list-scope check from the header's org", async () => {
    const allowed = await checkPermissionOnResource(ctxFor({ header: HEADER_ORG, org: CTX_ORG }), {
      resourceType: "server",
      resourceId: "*",
      action: "read",
      scope: "list",
    });
    expect(allowed).toBe(false);
  });

  it("still authorizes when ctx names the org the caller is in", async () => {
    // The other direction: without this the tests above would also pass if
    // checkPermissionOnResource simply started denying everything.
    const allowed = await checkPermissionOnResource(
      ctxFor({ header: CTX_ORG, org: HEADER_ORG }),
      JOB_WRITE,
    );
    expect(allowed).toBe(true);
  });

  it("needs no Hono context at all — works on a background ctx", async () => {
    // Pinning to ctx.organizationId means nothing on this path reads ctx.hono, so
    // buildBackgroundContext's throwing `hono` getter can't be tripped.
    const background = {
      userId: "u1",
      organizationId: HEADER_ORG,
      get hono(): Context {
        throw new Error("background ctx has no Hono request");
      },
    } as unknown as RequestContext;
    await expect(checkPermissionOnResource(background, JOB_WRITE)).resolves.toBe(true);
  });
});

describe("assert still establishes scope from the request", () => {
  it("resolves an org-singleton against the X-Organization-Id header", async () => {
    // ctx says orgB (not a member); the header says orgA (member). assert is the
    // scope-establishing entry point, so the header wins and this passes. Flipping
    // assert to ctx.organizationId too would break org switching on every list and
    // singleton route.
    await expect(
      assert(ctxFor({ header: HEADER_ORG, org: CTX_ORG }), {
        resourceType: "settings",
        resourceId: "*",
        action: "read",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws 404 when the header names an org the caller is not in", async () => {
    await expect(
      assert(ctxFor({ header: CTX_ORG, org: HEADER_ORG }), {
        resourceType: "settings",
        resourceId: "*",
        action: "read",
      }),
    ).rejects.toThrow();
  });
});
