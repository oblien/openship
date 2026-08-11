import { describe, it, expect } from "vitest";
import {
  cronFromParts,
  partsFromCron,
  DEFAULT_SCHEDULE_PARTS,
  DEFAULT_BACKUP_TIME,
  MAX_DAY_OF_MONTH,
  type ScheduleParts,
} from "./backup-schedule";

/**
 * The one property that matters: a schedule the picker drew must survive a save +
 * reload unchanged, and a schedule it can't draw must survive it *even more*
 * unchanged. Silently rewriting `0 star/6 star star star` into "daily at 00:00"
 * would change when an operator's backups run without telling them.
 */

const parts = (over: Partial<ScheduleParts> = {}): ScheduleParts => ({
  ...DEFAULT_SCHEDULE_PARTS,
  ...over,
});

describe("cronFromParts", () => {
  it("returns null for manual", () => {
    expect(cronFromParts(parts({ frequency: "manual", time: "09:30" }))).toBeNull();
  });

  it("builds daily / weekly / monthly at the chosen time", () => {
    expect(cronFromParts(parts({ frequency: "daily", time: "03:17" }))).toBe("17 3 * * *");
    expect(cronFromParts(parts({ frequency: "weekly", time: "23:05", weekday: 6 }))).toBe(
      "5 23 * * 6",
    );
    expect(cronFromParts(parts({ frequency: "monthly", time: "00:00", dayOfMonth: 12 }))).toBe(
      "0 0 12 * *",
    );
  });

  it("passes a custom expression through, trimmed", () => {
    expect(cronFromParts(parts({ frequency: "custom", custom: "  */15 * * * *  " }))).toBe(
      "*/15 * * * *",
    );
  });

  it("treats a cleared custom box as no schedule", () => {
    // Not an invalid cron the API should 400 on — the operator emptied the field.
    expect(cronFromParts(parts({ frequency: "custom", custom: "   " }))).toBeNull();
  });

  it("clamps the day of month to one that exists in February", () => {
    expect(cronFromParts(parts({ frequency: "monthly", dayOfMonth: 31 }))).toBe(
      `17 3 ${MAX_DAY_OF_MONTH} * *`,
    );
    expect(cronFromParts(parts({ frequency: "monthly", dayOfMonth: 0 }))).toBe("17 3 1 * *");
  });

  it("clamps an out-of-range weekday", () => {
    expect(cronFromParts(parts({ frequency: "weekly", weekday: 9 }))).toBe("17 3 * * 6");
    expect(cronFromParts(parts({ frequency: "weekly", weekday: -3 }))).toBe("17 3 * * 0");
  });

  it("refuses to guess at an unparseable time", () => {
    // Better no schedule than a schedule at an hour nobody picked.
    expect(cronFromParts(parts({ frequency: "daily", time: "" }))).toBeNull();
    expect(cronFromParts(parts({ frequency: "daily", time: "25:00" }))).toBeNull();
    expect(cronFromParts(parts({ frequency: "daily", time: "3pm" }))).toBeNull();
  });
});

describe("partsFromCron", () => {
  it("reads null / empty as manual at the default time", () => {
    expect(partsFromCron(null)).toEqual(DEFAULT_SCHEDULE_PARTS);
    expect(partsFromCron("   ")).toEqual(DEFAULT_SCHEDULE_PARTS);
    expect(DEFAULT_SCHEDULE_PARTS.time).toBe(DEFAULT_BACKUP_TIME);
  });

  it("recognizes the three drawable shapes", () => {
    expect(partsFromCron("17 3 * * *")).toMatchObject({ frequency: "daily", time: "03:17" });
    expect(partsFromCron("5 23 * * 6")).toMatchObject({
      frequency: "weekly",
      time: "23:05",
      weekday: 6,
    });
    expect(partsFromCron("0 0 12 * *")).toMatchObject({
      frequency: "monthly",
      time: "00:00",
      dayOfMonth: 12,
    });
  });

  it("folds cron's second Sunday onto the one the select has", () => {
    expect(partsFromCron("17 3 * * 7")).toMatchObject({ frequency: "weekly", weekday: 0 });
  });

  it("keeps a schedule it cannot draw exactly as written", () => {
    for (const expr of [
      "*/15 * * * *", // step
      "0 9-17 * * *", // range
      "0 0,12 * * *", // list
      "17 3 * 6 *", // a specific month
      "17 3 15 * 1", // day-of-month AND weekday
      "17 3 * * 1-5", // weekday range
      "@daily", // non-standard alias
      "17 3 * *", // four fields
      "17 3 * * * *", // six fields
      "17 3 29 * *", // a day February doesn't have
    ]) {
      expect(partsFromCron(expr), expr).toMatchObject({ frequency: "custom", custom: expr });
    }
  });

  it("rejects out-of-range numbers rather than drawing a wrong clock", () => {
    expect(partsFromCron("60 3 * * *")).toMatchObject({ frequency: "custom" });
    expect(partsFromCron("17 24 * * *")).toMatchObject({ frequency: "custom" });
  });

  it("round-trips every shape it claims to understand", () => {
    for (const expr of ["17 3 * * *", "5 23 * * 6", "0 0 12 * *", "*/15 * * * *"]) {
      expect(cronFromParts(partsFromCron(expr)), expr).toBe(expr);
    }
  });

  it("normalizes a padded hour back to the same cron", () => {
    // "07 3 * * *" is valid cron; the picker shows 03:07 and must not re-emit "07".
    expect(partsFromCron("07 03 * * *")).toMatchObject({ frequency: "daily", time: "03:07" });
    expect(cronFromParts(partsFromCron("07 03 * * *"))).toBe("7 3 * * *");
  });
});
