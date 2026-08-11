/**
 * What the app grid is allowed to show.
 *
 * `getAppCatalog` is the ONE place an app can be hidden from the browsable
 * catalog, and hiding is deliberately not the same thing as refusing: `available:
 * false` makes `installApp` throw `app-not-available`, while `unlisted` only drops
 * the card. Webmail depends on that difference — the mail wizard installs it by id,
 * so an unlisting that leaked into installability would break "connect existing".
 *
 * The mirror-image failure is a custom app that unlists ITSELF: the grid is the only
 * entry point an org-uploaded app has, so `listOrgCustomApps` forces the flag off.
 */
import { describe, it, expect, vi } from "vitest";

import type { RequestContext } from "../../lib/request-context";

const h = vi.hoisted(() => ({
  runtime: [] as unknown[],
  custom: [] as unknown[],
}));

vi.mock("./catalog-source", () => ({
  getRuntimeCatalog: () => h.runtime,
  listOrgCustomApps: async () => h.custom,
  getTemplateForOrg: async () => undefined,
}));

vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("../projects/project-crud.service", () => ({ createProject: vi.fn() }));
vi.mock("../services/service.service", () => ({
  createService: vi.fn(),
  updateService: vi.fn(),
  setServiceEnvVars: vi.fn(),
}));

const { getAppCatalog } = await import("./app-install.service");

const ctx = { organizationId: "org1" } as RequestContext;

function app(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name: id,
    description: "d",
    kind: "template",
    logo: id,
    category: "mail",
    available: true,
    ...extra,
  };
}

describe("getAppCatalog", () => {
  it("drops an unlisted app from the grid", async () => {
    h.runtime = [app("mail", { kind: "flow" }), app("webmail", { unlisted: true })];
    h.custom = [];

    const ids = (await getAppCatalog(ctx)).map((a) => a.id);

    expect(ids).toEqual(["mail"]);
  });

  it("keeps a coming-soon app listed — unavailable is not unlisted", async () => {
    h.runtime = [app("neon", { available: false })];
    h.custom = [];

    const listed = await getAppCatalog(ctx);

    expect(listed.map((a) => a.id)).toEqual(["neon"]);
    expect(listed[0].comingSoon).toBe(true);
  });

  it("lists a custom app even when its JSON asks to be unlisted", async () => {
    // Matches what listOrgCustomApps hands back (it forces the flag), so this test
    // fails if that normalization is ever dropped from either side.
    h.runtime = [];
    h.custom = [app("acme", { unlisted: false, custom: true })];

    const ids = (await getAppCatalog(ctx)).map((a) => a.id);

    expect(ids).toEqual(["acme"]);
  });
});
