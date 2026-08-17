import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Replacing a PRE-CATALOG webmail.
 *
 * A webmail deployed by 0.5.x/0.6.x is a project row stamped `mail-webmail` whose
 * source was a shipped `apps/email/dist` bundle. That pipeline is gone, so the row
 * can't be redeployed — deploying over it REPLACES it. Destructive, so:
 *
 *   • consent is required     → the first call refuses with 409 LEGACY_WEBMAIL and
 *                               touches nothing at all
 *   • order is load-bearing   → every cheap refusal (no install domain, catalog too
 *                               old) happens BEFORE the teardown, so we can never
 *                               delete a working webmail and then fail to replace it
 *   • a survivor blocks       → if the row doesn't drop, nothing is installed; two
 *                               webmails would fight over the hostname and host port
 *   • fresh, not reused       → the replacement installs from the template rather
 *                               than adopting the row that just went
 *
 * A CURRENT webmail is unaffected: it redeploys through `reuse`, with no teardown.
 */

const WEBMAIL_PROJECT = {
  id: "wm-new",
  organizationId: "org1",
  name: "Webmail example.com",
  slug: "webmail-example-com",
  appTemplateId: "webmail",
  framework: "docker-compose",
  serverId: "srv1",
  activeDeploymentId: null,
};

const LEGACY_PROJECT = {
  id: "wm-old",
  organizationId: "org1",
  name: "Webmail mail-1",
  slug: "webmail-mail-1",
  appTemplateId: "mail-webmail",
  framework: "webmail",
  serverId: "srv1",
  activeDeploymentId: "dep-old",
};

const h = vi.hoisted(() => ({
  /** The project `mail_servers.webmail_project_id` points at, if any. */
  linked: null as Record<string, unknown> | null,
  /** null = this instance's catalog has no webmail app. */
  template: null as unknown,
  rowDeleted: true,
  teardownFailure: "",

  teardownProject: vi.fn(),
  installApp: vi.fn(),
  // Params declared so the assertions can read `.mock.calls[0]` positionally.
  updateAppProjectSettings: vi.fn(
    async (_ctx: unknown, _projectId: string, _changes: unknown[]) => {},
  ),
  requestBuildAccess: vi.fn(async () => ({ deployment_id: "dep-new" })),
  setWebmailProject: vi.fn(async () => {}),
  updateService: vi.fn(async () => {}),
  ensureGeneratedAppSecrets: vi.fn(async () => [] as string[]),
}));

vi.mock("@repo/db", () => ({
  repos: {
    server: { get: vi.fn(async (id: string) => ({ id, organizationId: "org1" })) },
    mailServer: {
      get: vi.fn(async () => ({ domain: "example.com", webmailProjectId: h.linked?.id ?? null })),
      setWebmailProject: h.setWebmailProject,
    },
    project: {
      findById: vi.fn(async (id: string) => (h.linked?.id === id ? h.linked : null)),
      findFirstBySlug: vi.fn(async () => null),
    },
    service: { listByProject: vi.fn(async () => [{ id: "svc1", name: "webmail" }]) },
    deployment: { findById: vi.fn(async () => ({ status: "ready" })) },
  },
}));

vi.mock("../../projects/project-teardown", () => ({
  teardownProject: h.teardownProject,
}));
vi.mock("../../apps/catalog-source", () => ({
  getTemplateForOrg: vi.fn(async () => h.template),
}));
vi.mock("../../apps/app-install.service", () => ({
  installApp: h.installApp,
  planInstallRouting: vi.fn(() => new Map()),
  ensureGeneratedAppSecrets: h.ensureGeneratedAppSecrets,
}));
vi.mock("../../apps/app-settings.service", () => ({
  updateAppProjectSettings: h.updateAppProjectSettings,
}));
vi.mock("../../deployments/build.service", () => ({
  requestBuildAccess: h.requestBuildAccess,
}));
vi.mock("../../domains/project-route.service", () => ({
  listProjectRouteRows: vi.fn(async () => []),
}));
vi.mock("../../services/service.service", () => ({ updateService: h.updateService }));
vi.mock("../../../lib/ssh-manager", () => ({ sshManager: { withExecutor: vi.fn() } }));
vi.mock("../mail-state", () => ({ readState: vi.fn(), mutateState: vi.fn() }));

import { getAppTemplate } from "@repo/core";
import {
  LEGACY_WEBMAIL_ERROR_CODE,
  resolveWebmailSummary,
  startWebmailDeploy,
  WEBMAIL_SETTING_KEYS,
  WEBMAIL_TEMPLATE_ID,
} from "./webmail-install.service";

const ctx = { organizationId: "org1", userId: "u1" } as never;
const input = {
  mailServerId: "mail-1",
  hostname: "webmail.example.com",
  target: { kind: "self" as const, serverId: "srv1" },
};

beforeEach(() => {
  vi.clearAllMocks();
  h.linked = LEGACY_PROJECT;
  // The REAL catalog entry: the install derives the service + port from it, so a
  // hand-rolled stub would pass while the shipped app couldn't install.
  h.template = getAppTemplate(WEBMAIL_TEMPLATE_ID);
  h.rowDeleted = true;
  h.teardownFailure = "";
  h.teardownProject.mockImplementation(async () => ({
    ok: h.rowDeleted,
    rowDeleted: h.rowDeleted,
    steps: [],
    unrecoverable: h.teardownFailure
      ? [{ step: "cleanup_runtime", status: "failed", error: h.teardownFailure }]
      : [],
    orphaned: [],
    unlinked: [],
  }));
  h.installApp.mockImplementation(async () => ({
    kind: "template",
    projectId: WEBMAIL_PROJECT.id,
  }));
});

describe("legacy webmail replace", () => {
  it("refuses without consent, and touches nothing", async () => {
    const err = await startWebmailDeploy(ctx, input).catch((e) => e);

    expect(err.statusCode).toBe(409);
    expect(err.code).toBe(LEGACY_WEBMAIL_ERROR_CODE);
    expect(h.teardownProject).not.toHaveBeenCalled();
    expect(h.installApp).not.toHaveBeenCalled();
    expect(h.setWebmailProject).not.toHaveBeenCalled();
    expect(h.requestBuildAccess).not.toHaveBeenCalled();
  });

  it("with consent: tears the old project down, then installs the app fresh", async () => {
    const res = await startWebmailDeploy(ctx, { ...input, replaceLegacy: true });

    expect(h.teardownProject).toHaveBeenCalledWith(ctx, LEGACY_PROJECT.id, {
      force: true,
      wipeVolumes: true,
    });
    // Fresh install, NOT a redeploy of the row that just went: `installApp` owns the
    // routing, so no service row is patched with a routing plan. The one updateService
    // call here is the restart-loop watch (#566), which every path arms.
    expect(h.installApp).toHaveBeenCalledOnce();
    for (const call of h.updateService.mock.calls as unknown as unknown[][]) {
      expect(Object.keys(call[3] as object)).toEqual(["advanced"]);
    }
    // Link stamped before the build is queued, so the deploy hook can resolve it.
    expect(h.setWebmailProject).toHaveBeenCalledWith("mail-1", WEBMAIL_PROJECT.id);
    expect(res).toEqual({ projectId: WEBMAIL_PROJECT.id, deploymentId: "dep-new" });

    const teardownOrder = h.teardownProject.mock.invocationCallOrder[0]!;
    expect(h.installApp.mock.invocationCallOrder[0]!).toBeGreaterThan(teardownOrder);
  });

  it("writes the mail server's own IMAP/SMTP as the new app's settings", async () => {
    await startWebmailDeploy(ctx, { ...input, replaceLegacy: true });

    const [, projectId, changes] = h.updateAppProjectSettings.mock.calls[0]!;
    expect(projectId).toBe(WEBMAIL_PROJECT.id);
    // Keys via the constant — `webmail-catalog-contract.test.ts` is what pins those
    // to the catalog. What's asserted here is the VALUES: the replacement points at
    // the mail server it belongs to, not at the catalog's generic placeholders.
    const k = WEBMAIL_SETTING_KEYS;
    expect(changes).toEqual(
      expect.arrayContaining([
        { service: "webmail", key: k.imapHost, value: "mail.example.com" },
        { service: "webmail", key: k.imapPort, value: "993" },
        { service: "webmail", key: k.smtpHost, value: "mail.example.com" },
        { service: "webmail", key: k.smtpPort, value: "465" },
      ]),
    );
  });

  it("keeps the old webmail when the teardown leaves the row standing", async () => {
    h.rowDeleted = false;
    h.teardownFailure = "container in use";

    const err = await startWebmailDeploy(ctx, { ...input, replaceLegacy: true }).catch((e) => e);

    expect(err.statusCode).toBe(409);
    expect(err.message).toContain("container in use");
    expect(h.installApp).not.toHaveBeenCalled();
    expect(h.requestBuildAccess).not.toHaveBeenCalled();
  });

  it("refuses BEFORE the teardown when the catalog has no webmail app", async () => {
    h.template = null;

    const err = await startWebmailDeploy(ctx, { ...input, replaceLegacy: true }).catch((e) => e);

    expect(err.statusCode).toBe(409);
    expect(h.teardownProject).not.toHaveBeenCalled();
  });

  it("redeploys a CURRENT webmail in place — no teardown", async () => {
    h.linked = WEBMAIL_PROJECT;

    await startWebmailDeploy(ctx, input);

    expect(h.teardownProject).not.toHaveBeenCalled();
    expect(h.installApp).not.toHaveBeenCalled();
    // Reuse re-applies routing to the existing service rows instead.
    expect(h.requestBuildAccess).toHaveBeenCalledOnce();
  });

  it("reports a legacy install as legacy so the UI can offer the replace", async () => {
    const mailServer = { serverId: "mail-1", domain: "example.com", webmailProjectId: "wm-old" };

    expect(await resolveWebmailSummary("org1", mailServer)).toMatchObject({
      installed: true,
      legacy: true,
    });

    h.linked = WEBMAIL_PROJECT;
    expect(
      await resolveWebmailSummary("org1", { ...mailServer, webmailProjectId: "wm-new" }),
    ).toMatchObject({ legacy: false });
  });
});
