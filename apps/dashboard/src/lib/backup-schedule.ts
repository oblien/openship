/**
 * Cron ↔ "back up at 03:17, daily" — the two directions a schedule picker needs.
 *
 * `backup_policy.cron_expression` is the storage format and the only thing the
 * API's JobRunner reads (`backups/triggers/cron.ts` turns one policy into one
 * recurring job), so this converts rather than replaces it. Presets alone weren't
 * enough: every mail backup landed at 03:17 because that was the only daily option
 * the form could express, and an operator whose box is busy at 03:00 had no way to
 * say so without hand-writing cron.
 *
 * The time is wall-clock on the API host — `cron-parser` evaluates in the API
 * process's own zone, and nothing carries a zone from the browser. Label the field
 * accordingly; don't convert.
 *
 * Anything that doesn't fit the four shapes round-trips as `custom` with the raw
 * expression intact. A policy scheduled with a step or a range must not be
 * silently rewritten to something this file can draw.
 */

export type BackupFrequency = "manual" | "daily" | "weekly" | "monthly" | "custom";

export interface ScheduleParts {
  frequency: BackupFrequency;
  /** "HH:MM", 24-hour, in the API host's local time. */
  time: string;
  /** 0 = Sunday … 6 = Saturday. Weekly only. */
  weekday: number;
  /** 1–28. Monthly only. */
  dayOfMonth: number;
  /** Raw cron, kept verbatim when `frequency === "custom"`. */
  custom: string;
}

/**
 * 03:17, not 03:00. Every install that accepts the default would otherwise fire
 * on the same instant, and on a shared destination that's N concurrent uploads.
 * Same reasoning as the repo's existing `17 3 * * *` presets.
 */
export const DEFAULT_BACKUP_TIME = "03:17";

/** Highest day-of-month that exists in every month. 29–31 would skip February. */
export const MAX_DAY_OF_MONTH = 28;

export const DEFAULT_SCHEDULE_PARTS: ScheduleParts = {
  frequency: "manual",
  time: DEFAULT_BACKUP_TIME,
  weekday: 0,
  dayOfMonth: 1,
  custom: "",
};

const isInt = (s: string) => /^\d+$/.test(s);

function parseTime(time: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return { hour, minute };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Parts → cron, or null for "no schedule" (manual only, and an empty custom
 * expression — a blank box means the operator cleared it, not an invalid cron).
 */
export function cronFromParts(parts: ScheduleParts): string | null {
  if (parts.frequency === "manual") return null;
  if (parts.frequency === "custom") return parts.custom.trim() || null;

  const at = parseTime(parts.time);
  if (!at) return null;
  const { hour, minute } = at;

  if (parts.frequency === "daily") return `${minute} ${hour} * * *`;
  if (parts.frequency === "weekly") {
    const dow = Math.min(6, Math.max(0, Math.trunc(parts.weekday)));
    return `${minute} ${hour} * * ${dow}`;
  }
  const dom = Math.min(MAX_DAY_OF_MONTH, Math.max(1, Math.trunc(parts.dayOfMonth)));
  return `${minute} ${hour} ${dom} * *`;
}

/** Cron → parts. Never throws; anything unrecognized comes back as `custom`. */
export function partsFromCron(cron: string | null | undefined): ScheduleParts {
  const expr = (cron ?? "").trim();
  if (!expr) return { ...DEFAULT_SCHEDULE_PARTS };

  const asCustom = (): ScheduleParts => ({
    ...DEFAULT_SCHEDULE_PARTS,
    frequency: "custom",
    custom: expr,
  });

  const f = expr.split(/\s+/);
  if (f.length !== 5) return asCustom();
  const [min, hour, dom, month, dowRaw] = f;
  // Only a fixed minute-and-hour is drawable as a time. Steps, ranges and lists
  // (`*/15`, `9-17`, `0,30`) are real schedules — they just aren't this picker's.
  if (!isInt(min) || !isInt(hour) || month !== "*") return asCustom();
  if (Number(min) > 59 || Number(hour) > 23) return asCustom();

  // cron accepts both 0 and 7 for Sunday. The select only has 0, so fold it.
  const dow = dowRaw === "7" ? "0" : dowRaw;
  const time = `${pad(Number(hour))}:${pad(Number(min))}`;
  const base = { ...DEFAULT_SCHEDULE_PARTS, time };

  if (dom === "*" && dow === "*") return { ...base, frequency: "daily" };
  if (dom === "*" && isInt(dow) && Number(dow) <= 6) {
    return { ...base, frequency: "weekly", weekday: Number(dow) };
  }
  if (dow === "*" && isInt(dom) && Number(dom) >= 1 && Number(dom) <= MAX_DAY_OF_MONTH) {
    return { ...base, frequency: "monthly", dayOfMonth: Number(dom) };
  }
  return asCustom();
}
