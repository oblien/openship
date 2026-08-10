/**
 * Driver error text, reduced to printable ASCII and bounded, so a marker BUILT
 * from it is itself storable.
 *
 * When a payload write is rejected (a NUL in a text column, an unpaired
 * surrogate in jsonb), the fallback path embeds the DB error into a marker that
 * replaces the poisoned value — a rejected run with no reason reads as "no
 * reason given". But the driver's own message frequently echoes the offending
 * bytes verbatim, so a marker built from the RAW error can be just as
 * unstorable as the value it's standing in for, and the write fails again. This
 * strips everything outside printable ASCII and caps the length so the marker
 * always lands.
 *
 * Shared by every repo that persists a status/payload transition (backups,
 * restores, build sessions) so the salvage path can't drift.
 */
export function detailOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/[^\x20-\x7e]/g, "").slice(0, 300);
}
