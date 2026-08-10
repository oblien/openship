import { interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";

/**
 * Relative time, localized. Lived in `ProjectCard` until the project rows, the
 * Health tab and the issue feed all needed it — a shared helper beats a component
 * importing another route's card for a date string.
 *
 * Reads `t.projects.time.*` (where the strings already are, in all 9 locales) and
 * only handles PAST instants: a future timestamp lands in the `< 1 minute` branch
 * and reads "just now", so callers that count DOWN must do their own arithmetic.
 */
export function timeAgo(dateStr: string, t: Dictionary): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return t.projects.time.justNow;
  if (mins < 60) return interpolate(t.projects.time.minutesAgo, { count: String(mins) });
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return interpolate(t.projects.time.hoursAgo, { count: String(hrs) });
  const days = Math.floor(hrs / 24);
  if (days < 30) return interpolate(t.projects.time.daysAgo, { count: String(days) });
  return interpolate(t.projects.time.monthsAgo, { count: String(Math.floor(days / 30)) });
}
