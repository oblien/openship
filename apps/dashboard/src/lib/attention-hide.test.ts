import { beforeEach, describe, expect, it } from "vitest";

import { fingerprint, hide, isHidden } from "./attention-hide";

/**
 * The rule that makes a dismissible outage card safe.
 *
 * Every assertion here is the reason this isn't a plain boolean flag: hiding "edge is
 * down" must not also hide the certificate that failed an hour later, and it must not
 * hold forever. Node has no `localStorage`, so the tests bring their own — which also
 * pins the fail-soft path when storage is unavailable.
 */

const store = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

beforeEach(() => store.clear());

describe("fingerprint", () => {
  it("ignores order but not membership", () => {
    expect(fingerprint(["a", "b"])).toBe(fingerprint(["b", "a"]));
    expect(fingerprint(["a", "b"])).not.toBe(fingerprint(["a", "c"]));
    expect(fingerprint(["a", "b"])).not.toBe(fingerprint(["a"]));
    // Joined with a separator, so no pair of ids can be re-split into another pair.
    expect(fingerprint(["ab", "c"])).not.toBe(fingerprint(["a", "bc"]));
  });
});

describe("isHidden", () => {
  it("hides only the set that was dismissed", () => {
    hide("broken", ["edge:1"]);
    expect(isHidden("broken", ["edge:1"])).toBe(true);
  });

  it("comes back when a new issue joins the card", () => {
    // The whole point: dismissing a down edge must not swallow the cert that fails
    // an hour later, because the card would then be silent about something unread.
    hide("broken", ["edge:1"]);
    expect(isHidden("broken", ["edge:1", "ssl:acme.com"])).toBe(false);
  });

  it("comes back when one of the dismissed issues clears", () => {
    hide("broken", ["edge:1", "ssl:acme.com"]);
    expect(isHidden("broken", ["edge:1"])).toBe(false);
  });

  it("expires — a day for broken things, a week for updates", () => {
    const t0 = 1_700_000_000_000;
    hide("broken", ["edge:1"], t0);
    hide("behind", ["update:app"], t0);

    expect(isHidden("broken", ["edge:1"], t0 + 23 * HOUR)).toBe(true);
    expect(isHidden("broken", ["edge:1"], t0 + 25 * HOUR)).toBe(false);

    expect(isHidden("behind", ["update:app"], t0 + 6 * DAY)).toBe(true);
    expect(isHidden("behind", ["update:app"], t0 + 8 * DAY)).toBe(false);
  });

  it("keeps the two cards independent", () => {
    hide("behind", ["update:app"]);
    expect(isHidden("broken", ["edge:1"])).toBe(false);
  });

  it("never claims an empty card is hidden", () => {
    hide("broken", ["edge:1"]);
    expect(isHidden("broken", [])).toBe(false);
  });

  it("treats unreadable storage as not hidden", () => {
    store.set("openship:attentionHidden:broken", "not json");
    expect(isHidden("broken", ["edge:1"])).toBe(false);
  });
});
