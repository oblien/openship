import { describe, it, expect } from "vitest";

import { canonicalMailTab, LEGACY_MAIL_TABS, MAIL_TAB_KEYS } from "./mail-tabs";

/**
 * The retired keys are the point of this file. `?tab=test` and `?tab=inbound`
 * were live URLs — dropping them from the list without aliasing them wouldn't
 * error anywhere, it would silently land an old bookmark on Overview.
 */
describe("canonicalMailTab", () => {
  it("passes every current section through unchanged", () => {
    for (const key of MAIL_TAB_KEYS) expect(canonicalMailTab(key)).toBe(key);
  });

  it("follows a retired key to the section that absorbed it", () => {
    expect(canonicalMailTab("test")).toBe("sending");
    expect(canonicalMailTab("inbound")).toBe("notifications");
  });

  it("lands on Overview for no tab at all, or one we don't have", () => {
    expect(canonicalMailTab(null)).toBe("overview");
    expect(canonicalMailTab(undefined)).toBe("overview");
    expect(canonicalMailTab("")).toBe("overview");
    expect(canonicalMailTab("nope")).toBe("overview");
    // Object.prototype's names, which a hand-typed or crafted `?tab=` can carry.
    // A plain-object alias table answers these with an inherited function, and the
    // panel then matches no section and renders a blank page.
    for (const hostile of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty"]) {
      expect(canonicalMailTab(hostile), hostile).toBe("overview");
    }
    // Not normalised, deliberately — the rail compares the raw query too, so
    // accepting variants here would light nothing while rendering a section.
    expect(canonicalMailTab("Domains")).toBe("overview");
    expect(canonicalMailTab(" domains")).toBe("overview");
  });

  it("never aliases a key that is also a current section", () => {
    // A legacy entry shadowed by a real section would be dead code at best and,
    // if the section were ever re-added under its old name, a redirect away from
    // the page it names.
    expect(LEGACY_MAIL_TABS.size).toBeGreaterThan(0);
    for (const legacy of LEGACY_MAIL_TABS.keys()) {
      expect(MAIL_TAB_KEYS as readonly string[]).not.toContain(legacy);
      // And it must actually be followed, not merely absent from the key list.
      expect(canonicalMailTab(legacy)).not.toBe("overview");
    }
  });

  it("aliases point at sections that exist", () => {
    for (const target of LEGACY_MAIL_TABS.values()) {
      expect(MAIL_TAB_KEYS as readonly string[]).toContain(target);
    }
  });
});
