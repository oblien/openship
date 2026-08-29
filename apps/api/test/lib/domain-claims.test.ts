import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The GENERAL question the general routing paths ask.
 *
 * Both of them — the deploy path (`lib/routing-domains`) and the service-domain edit path
 * (`modules/domains/domain.service`) — used to call the MAIL predicate directly, each
 * carrying its own copy of the mail-specific reasoning inside logic that is otherwise
 * subsystem-blind. `domain.owner_type` was already general (`project`, `webhook`, `mail`);
 * the code just had no matching question.
 *
 * What is pinned here is the DISPATCH, not mail's rules — those stay in
 * mail-host-claim.test.ts. Namely: a hostname no subsystem speaks for is refused without
 * touching the database, a claim's answer is passed through in both directions, and one
 * claim throwing cannot turn the caller's conflict error into a 500.
 */

const { findByDomain, getServer, findProject } = vi.hoisted(() => ({
  findByDomain: vi.fn(),
  getServer: vi.fn(),
  findProject: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    mailServer: { findByDomain },
    server: { get: getServer },
    project: { findById: findProject },
  },
}));

import { routableWithoutOwnership } from "../../src/lib/domain-claims";

const MAIL_ROW = {
  hostname: "mail.example.com",
  ownerType: "mail",
  projectId: null,
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  findByDomain.mockResolvedValue({
    serverId: "srv_mail",
    domain: "example.com",
    webmailProjectId: "prj_webmail",
  });
  getServer.mockResolvedValue({ id: "srv_mail", organizationId: "org_1" });
  findProject.mockResolvedValue({ id: "prj_webmail", organizationId: "org_1" });
});

describe("routableWithoutOwnership", () => {
  it("passes a registered claim's yes through", async () => {
    expect(await routableWithoutOwnership("mail.example.com", "prj_webmail", MAIL_ROW)).toBe(true);
  });

  it("passes a registered claim's no through", async () => {
    // Same hostname, a project the mail server does not link to. The dispatcher must not
    // soften a claim's refusal — the caller's hijack guard depends on getting `false`.
    expect(await routableWithoutOwnership("mail.example.com", "prj_other", MAIL_ROW)).toBe(false);
  });

  it("refuses a hostname no subsystem speaks for, without a query", async () => {
    // The general paths call this for EVERY hostname on every deploy and domain edit, so
    // "no claim applies" has to be the cheap answer. If a claim ever starts hitting the
    // database before ruling itself out, this catches it as a cost regression.
    expect(await routableWithoutOwnership("app.example.com", "prj_webmail", null)).toBe(false);
    expect(findByDomain).not.toHaveBeenCalled();
    expect(getServer).not.toHaveBeenCalled();
  });

  it("still answers for a hostname with no row at all", async () => {
    // A claim can legitimately apply where nothing was ever recorded (mail's cert row is
    // written best-effort). If the dispatcher required a row, the caller would fall
    // through and MINT a project-owned row for the very host the claim protects.
    expect(await routableWithoutOwnership("mail.example.com", "prj_webmail", null)).toBe(true);
  });

  it("does not let a claim's failure become the caller's error", async () => {
    // Consulted on the way to a ConflictError. A thrown lookup must leave that refusal
    // standing, not replace a clear 409 with a 500 on an unrelated deploy.
    findByDomain.mockRejectedValue(new Error("db down"));
    await expect(
      routableWithoutOwnership("mail.example.com", "prj_webmail", MAIL_ROW),
    ).resolves.toBe(false);
  });
});
