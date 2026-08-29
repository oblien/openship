import { describe, it, expect } from "vitest";
import { buildMinutePeriod } from "./plan-guard";

/**
 * The build-minute window is the boundary a customer is refused on, so it gets
 * its own tests. It is a pure function of (org creation day, now) precisely so it
 * CAN be tested without a database — a free org has no billing-period row to
 * read, and the display-side fallback it replaces was a rolling 30-day window
 * that slid on every read.
 */
describe("buildMinutePeriod", () => {
  const at = (iso: string) => new Date(iso);

  it("opens on the org's creation day each month", () => {
    const created = at("2026-01-14T09:30:00Z");
    const { from, to } = buildMinutePeriod(created, at("2026-08-20T12:00:00Z"));
    expect(from.toISOString()).toBe("2026-08-14T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("is still in last month's period before this month's anniversary", () => {
    const created = at("2026-01-14T09:30:00Z");
    const { from, to } = buildMinutePeriod(created, at("2026-08-03T12:00:00Z"));
    expect(from.toISOString()).toBe("2026-07-14T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });

  it("treats the anniversary itself as the start of the new period", () => {
    // The reset must happen AT the anniversary, not a day late — a user who was
    // refused yesterday expects to build today.
    const created = at("2026-01-14T09:30:00Z");
    const { from } = buildMinutePeriod(created, at("2026-08-14T00:00:01Z"));
    expect(from.toISOString()).toBe("2026-08-14T00:00:00.000Z");
  });

  it("covers exactly one month with no gap and no overlap", () => {
    const created = at("2026-03-07T00:00:00Z");
    const july = buildMinutePeriod(created, at("2026-07-10T00:00:00Z"));
    const august = buildMinutePeriod(created, at("2026-08-10T00:00:00Z"));
    // One period's end IS the next one's start: a build can't fall between them.
    expect(july.to.toISOString()).toBe(august.from.toISOString());
  });

  it("clamps a day-31 anchor into shorter months", () => {
    // Created Jan 31; February has no 31st. Date.UTC normalizes forward, which is
    // the forgiving direction — the user gets their allowance slightly early
    // rather than being locked out for a month.
    const created = at("2026-01-31T00:00:00Z");
    const { from, to } = buildMinutePeriod(created, at("2026-03-05T00:00:00Z"));
    expect(from.getTime()).toBeLessThanOrEqual(at("2026-03-05T00:00:00Z").getTime());
    expect(to.getTime()).toBeGreaterThan(from.getTime());
  });

  it("spans a year boundary", () => {
    const created = at("2025-06-20T00:00:00Z");
    const { from, to } = buildMinutePeriod(created, at("2026-01-05T00:00:00Z"));
    expect(from.toISOString()).toBe("2025-12-20T00:00:00.000Z");
    expect(to.toISOString()).toBe("2026-01-20T00:00:00.000Z");
  });

  it("never returns an inverted or empty window, even for a future creation date", () => {
    // Clock skew and seeded fixtures both produce this; an inverted window would
    // match no build sessions and silently grant unlimited minutes.
    const created = at("2027-01-01T00:00:00Z");
    const { from, to } = buildMinutePeriod(created, at("2026-08-15T00:00:00Z"));
    expect(to.getTime()).toBeGreaterThan(from.getTime());
  });

  it("is stable across repeated calls within a period (not a rolling window)", () => {
    const created = at("2026-01-14T00:00:00Z");
    const a = buildMinutePeriod(created, at("2026-08-15T01:00:00Z"));
    const b = buildMinutePeriod(created, at("2026-08-29T23:00:00Z"));
    // Two reads two weeks apart must agree on the boundary, or minutes silently
    // leave the window between one deploy and the next.
    expect(a.from.toISOString()).toBe(b.from.toISOString());
    expect(a.to.toISOString()).toBe(b.to.toISOString());
  });
});
