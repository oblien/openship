/**
 * Hostname helpers shared by the DNS providers, so zone discovery reads names the
 * same way whichever provider answers.
 */

/** Bound remote lookups while preserving the suffixes nearest the zone apex. */
export const MAX_ZONE_CANDIDATES = 8;

/** Trailing dots and case are not part of a name's identity. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\.+$/, "");
}

/**
 * Suffixes that could be `hostname`'s zone, most specific first, bounded.
 *
 * "a.b.example.com" → ["a.b.example.com", "b.example.com", "example.com"].
 * Single-label inputs yield nothing: there is no zone to find for "localhost".
 */
export function zoneCandidates(hostname: string): string[] {
  const parts = normalizeName(hostname).split(".").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i <= parts.length - 2; i++) {
    out.push(parts.slice(i).join("."));
  }
  // Keep the LAST N — the apex end. A deep name's zone is near the apex, so
  // truncating from the specific end is what preserves the real candidate.
  return out.slice(-MAX_ZONE_CANDIDATES);
}
