import { describe, expect, it } from "vitest";

import { needsMailServerChoice, pickActiveMailServer } from "./mail-active-server";

/**
 * The rail (MailScopeContext) and /emails/webmail resolve the active server
 * independently — the provider isn't mounted in platform view. They must agree,
 * so the rule lives here and the stale-hint case is pinned: a `?serverId=` for a
 * forgotten server has to be IGNORED, not honoured, or every request made under
 * it 404s against a server the instance no longer knows.
 */

const s = (id: string, completed = true) => ({ id, completed });

describe("pickActiveMailServer", () => {
  it("honours a hint that names a known server", () => {
    expect(pickActiveMailServer([s("a"), s("b")], "b")?.id).toBe("b");
    // Including one that isn't installed yet — mid-install is exactly when you
    // deep-link to a specific server.
    expect(pickActiveMailServer([s("a"), s("b", false)], "b")?.id).toBe("b");
  });

  it("ignores a hint for a server that is gone, rather than scoping to it", () => {
    expect(pickActiveMailServer([s("a")], "deleted")?.id).toBe("a");
  });

  it("falls back to the only installed server", () => {
    expect(pickActiveMailServer([s("a", false), s("b"), s("c", false)], null)?.id).toBe("b");
  });

  it("falls back to the first row when the answer is ambiguous", () => {
    // Two installed servers: no basis to prefer either, so the list order wins
    // and the operator picks explicitly.
    expect(pickActiveMailServer([s("a"), s("b")], null)?.id).toBe("a");
    // None installed: the first row is still reachable (its setup screen).
    expect(pickActiveMailServer([s("a", false), s("b", false)], null)?.id).toBe("a");
  });

  it("returns null with no servers at all", () => {
    expect(pickActiveMailServer([], null)).toBeNull();
    expect(pickActiveMailServer([], "a")).toBeNull();
  });
});

describe("needsMailServerChoice", () => {
  it("asks when two installed servers could each own a webmail", () => {
    expect(needsMailServerChoice([s("a"), s("b")], null)).toBe(true);
  });

  it("never asks once a known server is named", () => {
    // The rail always names one, so clicking Webmail must not stop to ask.
    expect(needsMailServerChoice([s("a"), s("b")], "b")).toBe(false);
  });

  it("asks when the hint names a server that is gone", () => {
    // Stale bookmark for a forgotten server: guessing a survivor would open
    // some other domain's webmail, which is the one wrong answer available.
    expect(needsMailServerChoice([s("a"), s("b")], "deleted")).toBe(true);
  });

  it("doesn't ask when only one server could possibly have a webmail", () => {
    expect(needsMailServerChoice([s("a")], null)).toBe(false);
    // Half-provisioned boxes serve no mail, so they don't make it ambiguous.
    expect(needsMailServerChoice([s("a"), s("b", false)], null)).toBe(false);
    expect(needsMailServerChoice([s("a", false), s("b", false)], null)).toBe(false);
    expect(needsMailServerChoice([], null)).toBe(false);
  });
});
