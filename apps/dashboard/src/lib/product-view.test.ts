import { describe, expect, it } from "vitest";

import { isProductView, resolveProductView } from "./product-view";

/**
 * Both inputs are attacker-adjacent junk until proven otherwise: the cookie comes
 * from the browser and `instanceMode` from an unauthenticated /health/env. So what's
 * pinned here is (a) the precedence — per-user cookie over the instance default, in
 * BOTH directions — and (b) that only the two known values are ever returned.
 */

const at = (input: Partial<Parameters<typeof resolveProductView>[0]>) =>
  resolveProductView({ selfHosted: true, ...input });

describe("resolveProductView", () => {
  it("follows the instance default with no cookie", () => {
    expect(at({})).toBe("platform");
    expect(at({ instanceMode: "mail" })).toBe("mail");
  });

  it("lets a user opt into the mail rail on a platform box", () => {
    expect(at({ cookie: "mail" })).toBe("mail");
  });

  it("lets a user pop out to the full platform on a mail box", () => {
    // This direction is the load-bearing one: the webmail project lives in
    // /projects and a failed webmail deploy has to be debuggable, so the mail
    // rail can never be a trap.
    expect(at({ cookie: "platform", instanceMode: "mail" })).toBe("platform");
  });

  it("ignores a cookie that isn't a view and falls back to the instance", () => {
    expect(at({ cookie: "webmail", instanceMode: "mail" })).toBe("mail");
    expect(at({ cookie: "", instanceMode: "mail" })).toBe("mail");
    expect(at({ cookie: "Mail" })).toBe("platform");
  });

  it("ignores an instanceMode that isn't a view", () => {
    expect(at({ instanceMode: "emails" })).toBe("platform");
    expect(at({ instanceMode: null })).toBe("platform");
  });

  it("pins the platform on the SaaS, whatever the cookie or the instance say", () => {
    // /api/mail is localOnly, so a mail rail on cloud is a column of links that
    // all 403. A stale cookie from a self-hosted box on the same host must not
    // reach through.
    expect(resolveProductView({ cookie: "mail", selfHosted: false })).toBe("platform");
    expect(
      resolveProductView({ cookie: "mail", instanceMode: "mail", selfHosted: false }),
    ).toBe("platform");
  });
});

describe("isProductView", () => {
  it("accepts the two views and nothing else", () => {
    expect(isProductView("platform")).toBe(true);
    expect(isProductView("mail")).toBe(true);
    for (const bad of ["Mail", "mail ", "", null, undefined, 0, {}]) {
      expect(isProductView(bad)).toBe(false);
    }
  });
});
