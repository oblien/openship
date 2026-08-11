/**
 * "Hide this card" for the two home attention cards.
 *
 * Deliberately NOT an acknowledge feature. A hide is keyed to a fingerprint of the
 * exact issue ids the card was showing, so it can only ever hide what the operator
 * actually read: the moment a new problem appears — or one of these clears — the
 * fingerprint stops matching and the card comes back by itself. It also expires,
 * because "still down tomorrow" has earned its place on the home page again even if
 * nothing else changed.
 *
 * It hides a CARD, not an issue. `/issues` keeps listing everything with no filter,
 * the server never learns about any of this (no per-issue state, no migration), and
 * nothing another member's browser has to agree with. That is what keeps the feed
 * itself read-only.
 */

export type AttentionCardKey = "broken" | "behind";

/**
 * How long a hide holds. Broken things come back within the day; an update you
 * chose to defer stays deferred for a week.
 */
const WINDOW_MS: Record<AttentionCardKey, number> = {
  broken: 24 * 60 * 60 * 1000,
  behind: 7 * 24 * 60 * 60 * 1000,
};

const storageKey = (card: AttentionCardKey) => `openship:attentionHidden:${card}`;

interface HiddenState {
  fp: string;
  at: number;
}

/**
 * FNV-1a over the sorted ids. The stored value is a marker to compare, never a list
 * to read back, so a short hash beats keeping 40 ids in storage. Ids carry their
 * org's project/server ids, so switching organization can't match a fingerprint.
 */
export function fingerprint(ids: string[]): string {
  const joined = [...ids].sort().join("\n");
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${ids.length}:${(h >>> 0).toString(16)}`;
}

function read(card: AttentionCardKey): HiddenState | null {
  try {
    const raw = localStorage.getItem(storageKey(card));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as HiddenState;
    return typeof parsed?.fp === "string" && typeof parsed?.at === "number" ? parsed : null;
  } catch {
    return null; // storage off, or a value written by an older shape
  }
}

/** True while this exact set of issues is hidden and the window hasn't run out. */
export function isHidden(card: AttentionCardKey, ids: string[], now = Date.now()): boolean {
  if (ids.length === 0) return false;
  const state = read(card);
  if (!state) return false;
  if (now - state.at > WINDOW_MS[card]) return false;
  return state.fp === fingerprint(ids);
}

/** Hide the card for the set it is showing right now. */
export function hide(card: AttentionCardKey, ids: string[], now = Date.now()): void {
  try {
    localStorage.setItem(storageKey(card), JSON.stringify({ fp: fingerprint(ids), at: now }));
  } catch {
    /* private mode — the card simply doesn't stay hidden */
  }
}
