import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The mail server's own hostname is the one host a project may route without owning a
 * row — and it must be exactly one project, exactly one host.
 *
 * `mail.<base>` is recorded with `ownerType='mail', project_id=NULL` so the renewal sweep
 * can find its certificate. Both hijack guards compare `owner.projectId !== projectId`,
 * which NULL never satisfies, so the webmail the mail module itself deploys onto that host
 * was refused at install and silently unrouted at deploy (#566).
 *
 * What is pinned here is the TIGHTNESS. The link — `mail_servers.webmail_project_id` — is
 * the authorization, not "a project that looks like a webmail", because the loose version
 * would let an ordinary service edit take over the mail hostname.
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

import { mailHostBaseDomain } from "@repo/core";
import { mailHostRoutableByProject } from "../../src/lib/mail-host-claim";

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

// The local `mailBaseDomain` this used to cover is gone: it carried its own
// `/^mail\./` regex while ~40 other sites hand-wrote the forward template, so the
// build and the parse were two independent facts. Both now derive from
// MAIL_HOST_LABEL in @repo/core — same behaviour, one definition.
describe("mailHostBaseDomain", () => {
  it("strips only a leading mail label", () => {
    expect(mailHostBaseDomain("mail.example.com")).toBe("example.com");
    expect(mailHostBaseDomain("MAIL.Example.COM")).toBe("example.com");
    expect(mailHostBaseDomain("example.com")).toBeNull();
    expect(mailHostBaseDomain("webmail.example.com")).toBeNull();
  });

  it("rejects a host whose base is not a domain", () => {
    // `mail.com` used to strip to the bare TLD `com` and then cost a pointless
    // mail-server lookup. No install's user domain is a single label.
    expect(mailHostBaseDomain("mail.com")).toBeNull();
  });
});

describe("mailHostRoutableByProject", () => {
  it("lets the LINKED webmail route its mail server's host", async () => {
    expect(await mailHostRoutableByProject("mail.example.com", "prj_webmail", MAIL_ROW)).toBe(true);
  });

  it("answers for a mail host with no row at all", async () => {
    // recordMailCertDomain is best-effort, so the row can be missing. Without this the
    // caller mints a PROJECT-owned row for the mail host and the next mail install
    // refuses to record its certificate against it.
    expect(await mailHostRoutableByProject("mail.example.com", "prj_webmail", null)).toBe(true);
  });

  it("refuses a project that is not the linked webmail", async () => {
    expect(await mailHostRoutableByProject("mail.example.com", "prj_other", MAIL_ROW)).toBe(false);
  });

  it("refuses when no webmail is linked yet", async () => {
    findByDomain.mockResolvedValue({
      serverId: "srv_mail",
      domain: "example.com",
      webmailProjectId: null,
    });

    expect(await mailHostRoutableByProject("mail.example.com", "prj_webmail", MAIL_ROW)).toBe(false);
  });

  it("refuses across organizations even when the link points here", async () => {
    // The link is a pointer the mail module writes; org authority comes from the server.
    findProject.mockResolvedValue({ id: "prj_webmail", organizationId: "org_2" });

    expect(await mailHostRoutableByProject("mail.example.com", "prj_webmail", MAIL_ROW)).toBe(false);
  });

  it("refuses a row another project already owns", async () => {
    const owned = { hostname: "mail.example.com", ownerType: null, projectId: "prj_other" } as never;

    expect(await mailHostRoutableByProject("mail.example.com", "prj_webmail", owned)).toBe(false);
  });

  it("refuses a row this project already owns — that row should not exist", async () => {
    const mine = { hostname: "mail.example.com", ownerType: "mail", projectId: "prj_webmail" } as never;

    expect(await mailHostRoutableByProject("mail.example.com", "prj_webmail", mine)).toBe(false);
  });

  it("has nothing to say about a hostname that is not a mail host", async () => {
    expect(await mailHostRoutableByProject("webmail.example.com", "prj_webmail", null)).toBe(false);
    expect(findByDomain).not.toHaveBeenCalled();
  });

  it("refuses when no mail server owns that base domain", async () => {
    findByDomain.mockResolvedValue(undefined);

    expect(await mailHostRoutableByProject("mail.nothere.com", "prj_webmail", null)).toBe(false);
  });

  // It is consulted on the way to an error, so a failed lookup must leave the caller's
  // refusal in place rather than replace it with a 500.
  it("refuses rather than throwing when a lookup fails", async () => {
    findByDomain.mockRejectedValue(new Error("db down"));

    expect(await mailHostRoutableByProject("mail.example.com", "prj_webmail", MAIL_ROW)).toBe(false);
  });
});
