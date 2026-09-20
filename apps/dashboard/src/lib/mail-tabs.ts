/**
 * The mail admin panel's sections, and the one place a URL's `?tab=` becomes one.
 *
 * Lives beside `sidebar-nav.ts` rather than inside the /emails route because the
 * sections are shared vocabulary: the panel renders a tab bar from this list, the
 * mail rail renders the same list as nav entries, and both have to agree with the
 * URL about which section a `?tab=` names.
 *
 * Two sections were folded away after their URLs had already shipped — they live
 * in bookmarks, in links we sent, and in browser history:
 *
 *   - `test` is no longer a section. Sending a test email is a check on the
 *     outbound path you just chose, so it's an action inside Sending.
 *   - `inbound` is now `notifications`. The rules were always "tell me in a
 *     channel"; only the API still calls them inbound, and an operator looking
 *     for where mail notifications are configured did not look under Inbound.
 *
 * Resolving here rather than at each reader is what keeps them from disagreeing:
 * `admin-panel` picks which section to render, `mail-console` picks the heading
 * above it, and `isNavItemActive` picks which rail entry lights up — all three
 * through this function, so a stale `?tab=test` shows Sending, titled Sending,
 * with Sending highlighted, instead of one of the three going its own way.
 *
 * Deliberately free of React and of lucide: a pure lookup, unit-testable without
 * the dashboard's providers.
 */

/** Every section, in the order the tab bar and the rail list them. */
export const MAIL_TAB_KEYS = [
  "overview",
  "domains",
  "mailboxes",
  "aliases",
  "notifications",
  "sending",
  "dns",
  "health",
  "backup",
  "advanced",
] as const;

export type MailTabKey = (typeof MAIL_TAB_KEYS)[number];

/**
 * Retired `?tab=` values → the section that absorbed them.
 *
 * A Map, not an object: the key comes from the URL, and a plain object would answer
 * `?tab=constructor` with `Object.prototype.constructor` — a function that equals
 * no section, so every `tab === "…"` guard in the panel goes false and the page
 * renders empty. A Map has no inherited keys to hit.
 */
export const LEGACY_MAIL_TABS: ReadonlyMap<string, MailTabKey> = new Map([
  ["test", "sending"],
  ["inbound", "notifications"],
] as const);

const KEYS: readonly string[] = MAIL_TAB_KEYS;

/**
 * The section `raw` names, following a retired key to its replacement.
 *
 * Anything unrecognised falls back to Overview rather than rendering nothing —
 * the panel has no "unknown section" state, and a hand-typed `?tab=` should not
 * be able to produce an empty page.
 */
export function canonicalMailTab(raw: string | null | undefined): MailTabKey {
  if (!raw) return "overview";
  if (KEYS.includes(raw)) return raw as MailTabKey;
  return LEGACY_MAIL_TABS.get(raw) ?? "overview";
}
