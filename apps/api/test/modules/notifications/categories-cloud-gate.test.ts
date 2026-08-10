import { describe, it, expect, vi } from "vitest";

/**
 * GET /categories hides the billing group outside CLOUD_MODE — those two
 * categories are fed by Stripe/Oblien, so on a self-hosted box they are toggles
 * that can never fire, and the tab strip gives a group far more prominence than
 * two rows in a flat list ever did.
 *
 * The subtle half is WHERE the filter lives. `findCategory` supplies the title
 * and first body line of every delivered alert (notification-workers.ts) and the
 * dispatcher's defaultEnabled fallback, so the registry itself has to stay
 * complete: an org that already holds a billing default row must still render a
 * readable message, not a raw category id. Hence the last assertion here — it's
 * the one that fails if someone "simplifies" this by filtering CATEGORIES.
 */

const h = vi.hoisted(() => ({ cloudMode: false }));

vi.mock("../../../src/config/env", () => ({
  env: {
    get CLOUD_MODE() {
      return h.cloudMode;
    },
  },
}));

// The controller's remaining top-level imports reach the DB pool, SSH, and the
// notification workers. listCategories touches none of them.
vi.mock("@repo/db", () => ({ repos: {} }));
vi.mock("../../../src/lib/request-context", () => ({ getRequestContext: () => ({}) }));
vi.mock("../../../src/lib/audit", () => ({ audit: {}, auditContextFrom: () => ({}) }));
vi.mock("../../../src/lib/encryption", () => ({ encrypt: (v: string) => v }));
vi.mock("../../../src/lib/ssrf-guard", () => ({
  assertPublicUrlLiteral: () => {},
  SsrfError: class extends Error {},
}));
vi.mock("../../../src/lib/notification-workers", () => ({ sendTestToChannel: async () => {} }));

import { listCategories } from "../../../src/modules/notifications/notifications.controller";
import { findCategory } from "../../../src/lib/notification-categories";

interface Payload {
  categories: { id: string; group: string; label: string }[];
  groups: { id: string; label: string }[];
}

async function fetchCategories(cloudMode: boolean): Promise<Payload> {
  h.cloudMode = cloudMode;
  const captured: { body?: Payload } = {};
  await listCategories({
    json: (body: Payload) => {
      captured.body = body;
      return new Response(null);
    },
  } as never);
  return captured.body!;
}

describe("GET /categories billing gate", () => {
  it("drops the billing group from both arrays on self-hosted", async () => {
    const { categories, groups } = await fetchCategories(false);

    expect(groups.map((g) => g.id)).not.toContain("billing");
    expect(categories.map((c) => c.id)).not.toContain("billing.alert");
    expect(categories.map((c) => c.id)).not.toContain("quota.warning");
    // No category may point at a group the UI wasn't given — that would be a row
    // reachable only from the "All" tab, with a chip it can't label.
    const groupIds = new Set(groups.map((g) => g.id));
    for (const cat of categories) expect(groupIds).toContain(cat.group);
  });

  it("keeps billing on cloud", async () => {
    const { categories, groups } = await fetchCategories(true);
    expect(groups.map((g) => g.id)).toContain("billing");
    expect(categories.map((c) => c.id)).toContain("billing.alert");
    expect(categories.map((c) => c.id)).toContain("quota.warning");
  });

  it("still renders billing alerts on a self-hosted box", async () => {
    // The registry is untouched by the gate, so a pre-existing row keeps its
    // human label instead of degrading to "billing.alert".
    await fetchCategories(false);
    expect(findCategory("billing.alert")?.label).toBe("Billing alert");
    expect(findCategory("quota.warning")?.label).toBe("Quota warning");
  });

  it("exposes every group the categories reference", async () => {
    const { categories, groups } = await fetchCategories(true);
    expect(new Set(categories.map((c) => c.group))).toEqual(new Set(groups.map((g) => g.id)));
  });
});
