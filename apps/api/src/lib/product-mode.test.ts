import { describe, expect, it, vi, beforeEach } from "vitest";

/**
 * What's pinned here is the PRECEDENCE, because each rung of it was a deliberate
 * choice with a failure behind it:
 *
 *   • CLOUD_MODE outranks everything — /api/mail is localOnly, so a mail rail on
 *     the SaaS is a screen of links that all 403.
 *   • the stored setting outranks env — the toggle has to work without an operator
 *     editing the launcher's environment and restarting the API.
 *   • a broken settings read falls back to env instead of failing closed — this
 *     value picks which nav to draw; there is nothing to fail closed about, and a
 *     mail-only operator dropped into a platform UI can't get to the mail pages.
 */

const h = vi.hoisted(() => ({
  env: { CLOUD_MODE: false, OPENSHIP_PRODUCT: "platform" as string },
  /** What `instanceSettings.get()` answers — or throws, when it's an Error. */
  settings: null as unknown,
}));

vi.mock("../config/env", () => ({ env: h.env }));
vi.mock("@repo/db", () => ({
  repos: {
    instanceSettings: {
      get: async () => {
        if (h.settings instanceof Error) throw h.settings;
        return h.settings;
      },
    },
  },
}));

import { clearProductModeCache, isProductMode, resolveProductMode } from "./product-mode";

beforeEach(() => {
  h.env.CLOUD_MODE = false;
  h.env.OPENSHIP_PRODUCT = "platform";
  h.settings = null;
  clearProductModeCache();
});

describe("resolveProductMode", () => {
  it("defaults to the platform with nothing declared and nothing stored", async () => {
    expect(await resolveProductMode()).toBe("platform");
  });

  it("honours the launcher's declaration when nothing is stored", async () => {
    // `openship up --mail` → OPENSHIP_PRODUCT=mail in the compose .env / unit argv.
    h.env.OPENSHIP_PRODUCT = "mail";
    expect(await resolveProductMode()).toBe("mail");
  });

  it("lets the stored setting override the declaration, in both directions", async () => {
    h.settings = { productMode: "mail" };
    expect(await resolveProductMode()).toBe("mail");

    // And the case the dashboard toggle depends on: turning mail OFF on a box whose
    // env declares it. The toggle writes an explicit "platform" for exactly this —
    // clearing the row would hand the decision back to OPENSHIP_PRODUCT.
    clearProductModeCache();
    h.env.OPENSHIP_PRODUCT = "mail";
    h.settings = { productMode: "platform" };
    expect(await resolveProductMode()).toBe("platform");
  });

  it("ignores a stored value that isn't a mode", async () => {
    h.env.OPENSHIP_PRODUCT = "mail";
    h.settings = { productMode: "webmail" };
    expect(await resolveProductMode()).toBe("mail");
  });

  it("forces the platform in cloud mode, whatever env or the DB say", async () => {
    h.env.CLOUD_MODE = true;
    h.env.OPENSHIP_PRODUCT = "mail";
    h.settings = { productMode: "mail" };
    expect(await resolveProductMode()).toBe("platform");
  });

  it("never caches the cloud answer over a self-hosted one", async () => {
    // The cloud short-circuit returns BEFORE the cache is consulted or written, so a
    // cached "platform" from a cloud call can't outlive it. Pinned because the check
    // sits above the cache read and reordering the two would look harmless.
    h.env.CLOUD_MODE = true;
    expect(await resolveProductMode()).toBe("platform");
    h.env.CLOUD_MODE = false;
    h.settings = { productMode: "mail" };
    expect(await resolveProductMode()).toBe("mail");
  });

  it("falls back to the declaration when the settings read fails", async () => {
    h.env.OPENSHIP_PRODUCT = "mail";
    h.settings = new Error("no database");
    expect(await resolveProductMode()).toBe("mail");
  });

  it("caches until a write clears it", async () => {
    h.settings = { productMode: "mail" };
    expect(await resolveProductMode()).toBe("mail");

    // /health/env is unauthenticated and polled by every dashboard load, so the
    // second read must not hit the DB — a changed row is only picked up once the
    // settings write clears the cache.
    h.settings = { productMode: "platform" };
    expect(await resolveProductMode()).toBe("mail");
    clearProductModeCache();
    expect(await resolveProductMode()).toBe("platform");
  });
});

describe("isProductMode", () => {
  it("accepts the two modes and nothing else", () => {
    expect(isProductMode("platform")).toBe(true);
    expect(isProductMode("mail")).toBe(true);
    for (const bad of ["Mail", "", null, undefined, 1, {}]) {
      expect(isProductMode(bad)).toBe(false);
    }
  });
});
