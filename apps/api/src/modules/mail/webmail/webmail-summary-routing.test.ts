import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The hostname on the /emails webmail card is DERIVED, and one of its inputs can fail.
 *
 * A cloud webmail with no route of its own is fronted by the mail VPS at
 * `mail.<domain>`; a webmail that took a hostname is served by the edge at that
 * hostname. Both are computed from the project's route rows — so "the list is empty"
 * and "the list could not be read" must not be the same event. Reading a failed query
 * as an empty one hands back `mail.<domain>` for a webmail that has an address of its
 * own, i.e. an Open-webmail CTA pointing at the mail box.
 *
 * The summary can't just throw: `mail.controller.ts` catches the whole thing, so a
 * throw here deletes a deployed webmail from the page. It has to degrade INSIDE —
 * no hostname, no URL, but still `installed` + `projectId` so the logs stay reachable.
 */

const CLOUD_WEBMAIL = {
  id: "wm-cloud",
  organizationId: "org1",
  name: "Webmail example.com",
  slug: "webmail-example-com",
  appTemplateId: "webmail",
  framework: "docker-compose",
  serverId: null,
  cloudWorkspaceId: "ws1",
  activeDeploymentId: "dep1",
};

const SELF_WEBMAIL = {
  ...CLOUD_WEBMAIL,
  id: "wm-self",
  serverId: "srv1",
  cloudWorkspaceId: null,
};

const MAIL_SERVER = {
  serverId: "srv1",
  domain: "example.com",
  webmailProjectId: CLOUD_WEBMAIL.id,
};

const h = vi.hoisted(() => ({
  project: null as Record<string, unknown> | null,
  /** null = the read REJECTED; an array = rows we actually have. */
  rows: [] as Array<Record<string, unknown>> | null,
  /** Service rows, consulted only when the project has no domain row at all. */
  services: [] as Array<Record<string, unknown>>,
}));

vi.mock("@repo/db", () => ({
  repos: {
    project: {
      findById: vi.fn(async (id: string) => (h.project?.id === id ? h.project : null)),
      findFirstBySlug: vi.fn(async () => null),
    },
    mailServer: { setWebmailProject: vi.fn(async () => {}) },
    service: { listByProject: vi.fn(async () => h.services) },
    deployment: { findById: vi.fn(async () => ({ status: "ready" })) },
  },
}));

vi.mock("../../domains/project-route.service", () => ({
  listProjectRouteRows: vi.fn(async () => {
    if (h.rows === null) throw new Error("db unreachable");
    return h.rows;
  }),
}));

// Module-scope imports of the service under test, stubbed because nothing here runs
// an install. `pickCanonicalDomainRow` is deliberately NOT mocked — the verified/primary
// precedence is half of what's being asserted.
vi.mock("../../../lib/ssh-manager", () => ({ sshManager: { withExecutor: vi.fn() } }));
vi.mock("../../projects/project-teardown", () => ({ teardownProject: vi.fn() }));
vi.mock("../../apps/catalog-source", () => ({ getTemplateForOrg: vi.fn(async () => null) }));
vi.mock("../../apps/app-install.service", () => ({
  installApp: vi.fn(),
  planInstallRouting: vi.fn(() => new Map()),
  ensureGeneratedAppSecrets: vi.fn(async () => []),
}));
vi.mock("../../apps/app-settings.service", () => ({ updateAppProjectSettings: vi.fn() }));
vi.mock("../../deployments/build.service", () => ({ requestBuildAccess: vi.fn() }));
vi.mock("../../services/service.service", () => ({ updateService: vi.fn() }));
vi.mock("../mail-state", () => ({ readState: vi.fn(), mutateState: vi.fn() }));

import { resolveWebmailSummary } from "./webmail-install.service";

beforeEach(() => {
  vi.clearAllMocks();
  h.project = CLOUD_WEBMAIL;
  h.rows = [];
});

describe("webmail summary routing", () => {
  it("derives the mail-VPS proxy hostname for a cloud webmail with no route of its own", async () => {
    expect(await resolveWebmailSummary("org1", MAIL_SERVER)).toEqual({
      installed: true,
      hostname: "mail.example.com",
      url: "https://mail.example.com",
      routingUnknown: false,
      projectId: CLOUD_WEBMAIL.id,
      legacy: false,
    });
  });

  it("uses the routed hostname even before it verifies", async () => {
    // A custom domain behind a CDN may never verify, yet its vhost is written and it
    // is the address the operator opens. Unverified rows still beat the proxy default.
    h.rows = [{ hostname: "webmail.example.com", verified: false, isPrimary: false }];

    expect(await resolveWebmailSummary("org1", MAIL_SERVER)).toMatchObject({
      hostname: "webmail.example.com",
      url: "https://webmail.example.com",
    });
  });

  it("reports no hostname at all when the route list cannot be read", async () => {
    h.rows = null;

    // Not `mail.example.com`: an unreadable list is not an empty one, and this project
    // may well own a hostname. Deployment state survives so the card and its logs link
    // stay on the page — degrading the derived field, not the whole summary.
    expect(await resolveWebmailSummary("org1", MAIL_SERVER)).toEqual({
      installed: true,
      hostname: "",
      url: "",
      routingUnknown: true,
      projectId: CLOUD_WEBMAIL.id,
      legacy: false,
    });
  });

  it("says WHY there is no hostname, so a redeploy can't relocate a live webmail", async () => {
    // Withholding the hostname is only half a fix. `hostname: ""` also means "deployed
    // with no domain", and the redeploy form prefills `mail.<domain>` on that state —
    // which on a webmail that already has an address MOVES it, silently, on a transient
    // read failure. The two states have to be tellable apart at the boundary; they
    // differ in nothing else.
    h.project = SELF_WEBMAIL;
    const server = { ...MAIL_SERVER, webmailProjectId: SELF_WEBMAIL.id };

    // No domain row AND no routed service: genuinely addressless.
    h.services = [];
    h.rows = [];
    const unrouted = await resolveWebmailSummary("org1", server);
    h.rows = null;
    const unknown = await resolveWebmailSummary("org1", server);

    expect(unrouted?.hostname).toBe(unknown?.hostname);
    expect(unrouted?.routingUnknown).toBe(false);
    expect(unknown?.routingUnknown).toBe(true);
  });

  it("never proxies a self-hosted webmail, read or not", async () => {
    // The proxy variant is cloud-only, so `mail.<domain>` must not appear here in
    // either direction — the failed-read path and the empty-list path agree.
    h.project = SELF_WEBMAIL;
    h.services = [];
    const server = { ...MAIL_SERVER, webmailProjectId: SELF_WEBMAIL.id };

    expect(await resolveWebmailSummary("org1", server)).toMatchObject({ hostname: "", url: "" });

    h.rows = null;
    expect(await resolveWebmailSummary("org1", server)).toMatchObject({ hostname: "", url: "" });
  });

  /**
   * A webmail on the mail server's OWN hostname owns no domain row on purpose — that row
   * belongs to the mail install's certificate renewal (#566). Without this fallback the
   * card reads a deployed, serving webmail as "not installed" and offers to deploy it
   * again.
   */
  it("reads the address off the service when the mail host owns no domain row", async () => {
    h.project = SELF_WEBMAIL;
    h.rows = [];
    h.services = [
      {
        name: "webmail",
        exposed: true,
        publicEndpoints: [{ port: 4080, domainType: "custom", customDomain: "mail.example.com" }],
      },
    ];

    expect(await resolveWebmailSummary("org1", { ...MAIL_SERVER, webmailProjectId: SELF_WEBMAIL.id }))
      .toMatchObject({ hostname: "mail.example.com", url: "https://mail.example.com" });
  });

  it("still refuses to guess when the route read failed", async () => {
    // routingUnknown must win over the service fallback: an unreadable domain list is
    // not evidence that the service's hostname is the live one.
    h.project = SELF_WEBMAIL;
    h.rows = null;
    h.services = [
      {
        name: "webmail",
        exposed: true,
        publicEndpoints: [{ port: 4080, domainType: "custom", customDomain: "mail.example.com" }],
      },
    ];

    expect(await resolveWebmailSummary("org1", { ...MAIL_SERVER, webmailProjectId: SELF_WEBMAIL.id }))
      .toMatchObject({ hostname: "", routingUnknown: true });
  });
});
