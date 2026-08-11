/**
 * Number formatting shared by the Monitoring cards.
 *
 * Bytes deliberately reuse `@/lib/formatBytes` rather than reimplementing it — an
 * independent copy is how "1.5 GB" here and "1.50 GB" two cards over start
 * disagreeing about the same value.
 *
 * `formatCount` and `formatMb` are new because nothing shared covered them:
 * counts need K/M abbreviation (a 12-digit request total wrecks a card's layout),
 * and memory arrives already in MB from the runtimes, so routing it through a
 * bytes formatter would mean multiplying back up just to divide down again.
 */

export { formatBytes } from "@/lib/formatBytes";

/** Abbreviated count for a card: 1234 → "1.2K", 4_500_000 → "4.5M". */
export function formatCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Megabytes as given by `ResourceUsage`, promoted to GB past 1024.
 *
 * Decimals shrink as the number grows: "512 MB" reads better than "512.0 MB", and
 * "1.25 GB" carries information "1 GB" loses.
 */
export function formatMb(mb: number | null | undefined): string {
  if (mb == null || !Number.isFinite(mb)) return "—";
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}
