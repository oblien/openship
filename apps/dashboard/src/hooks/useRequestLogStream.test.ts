import { describe, it, expect } from "vitest";
import { normalizeRequestLog } from "./useRequestLogStream";

/**
 * The producers feeding this do NOT agree on field names:
 *
 *   • the ring buffer                         — uri, ts, status, bw_in/bw_out, rt
 *     (now the single edge source: both `/logs/recent` AND the live SSE stream read it)
 *   • the cloud relay                         — path, statusCode, responseTime
 *   • legacy long-name frames                 — uri, timestamp, status, requestSize
 *     (the shape the old dedicated live pipe emitted; still accepted defensively)
 *
 * The shapes below are copied from frames observed against a real edge container, not
 * invented, because the whole reason this function exists is that guessing which name a
 * producer uses is how `country` came to be dropped on one path and kept on another.
 */

/** The long-name shape the old dedicated live pipe emitted — still normalised so a
 *  mid-upgrade edge or the cloud relay's overlapping names keep working. */
const LIVE_FRAME = {
  host: "shop.example.com",
  status: 200,
  ip: "8.8.8.8",
  country: "US",
  method: "GET",
  date: "2026-08-03 22:44:31",
  uri: "/",
  timestamp: 1785797071.741,
  userAgent: "Wget",
  requestSize: 119,
  responseSize: 151,
  id: "1785797071.741-72896",
  responseTime: 0,
};

/** Verbatim from the edge ring — the shape `/logs/recent` and the live SSE stream now
 *  both deliver. */
const RING_ROW = {
  ip: "82.196.0.1",
  country: "NL",
  ts: 1785797000.5,
  method: "POST",
  status: "404",
  uri: "/api/orders?token=abc",
  ua: "curl/8",
  bw_in: 300,
  bw_out: 900,
  rt: 0.042,
};

describe("country survives every producer", () => {
  it("keeps it from a long-name frame", () => {
    expect(normalizeRequestLog(LIVE_FRAME)?.country).toBe("US");
  });

  it("keeps it from a ring-buffer row", () => {
    // This is the case that was broken: site_logger wrote no country into the ring
    // buffer, so backfilled rows showed no flag while live rows did — same traffic.
    expect(normalizeRequestLog(RING_ROW)?.country).toBe("NL");
  });

  it("reports absence as undefined, never as an empty string", () => {
    // A box with no GeoIP database, or a private client address. `country: ""` would
    // render a broken flag image; undefined renders nothing.
    expect(normalizeRequestLog({ ...RING_ROW, country: "" })?.country).toBeUndefined();
    const { country, ...noCountry } = RING_ROW;
    expect(normalizeRequestLog(noCountry)?.country).toBeUndefined();
  });
});

describe("the differing field names all land in one shape", () => {
  it("reads uri or path", () => {
    expect(normalizeRequestLog(RING_ROW)?.path).toBe("/api/orders?token=abc");
    expect(normalizeRequestLog({ path: "/cloud" })?.path).toBe("/cloud");
  });

  it("reads status or statusCode, as a number either way", () => {
    expect(normalizeRequestLog(RING_ROW)?.statusCode).toBe(404);
    expect(normalizeRequestLog(LIVE_FRAME)?.statusCode).toBe(200);
    expect(normalizeRequestLog({ statusCode: "503" })?.statusCode).toBe(503);
  });

  it("converts response time from seconds to milliseconds", () => {
    // The edge reports float seconds; the UI shows ms. Getting this wrong makes a 42ms
    // request read as 0ms.
    expect(normalizeRequestLog(RING_ROW)?.responseTime).toBe(42);
    expect(normalizeRequestLog({ rt: 1.2345 })?.responseTime).toBe(1235);
    expect(normalizeRequestLog({ responseTime: 0.5 })?.responseTime).toBe(500);
  });

  it("reads byte counters under either name", () => {
    const e = normalizeRequestLog(RING_ROW)!;
    expect(e.requestSize).toBe(300);
    expect(e.responseSize).toBe(900);
  });
});

describe("timestamps", () => {
  it("treats float seconds as seconds and epoch millis as millis", () => {
    // Both producers send a bare number and neither says which unit. Magnitude is the
    // only reliable discriminator: seconds are ~1.7e9, millis ~1.7e12.
    expect(normalizeRequestLog({ ts: 1785797071.741 })?.timestamp).toBe(
      new Date(1785797071741).toISOString(),
    );
    expect(normalizeRequestLog({ ts: 1785797071741 })?.timestamp).toBe(
      new Date(1785797071741).toISOString(),
    );
  });

  it("falls back to now rather than to an invalid date", () => {
    const ts = normalizeRequestLog({ ts: "not a date" })?.timestamp;
    expect(Number.isNaN(Date.parse(ts!))).toBe(false);
  });
});

describe("hostile or broken frames", () => {
  it("rejects a non-object without throwing", () => {
    for (const bad of [null, undefined, "", 0, "a string", []]) {
      // An array IS an object, so it normalises to a row of defaults rather than null;
      // what matters is that nothing throws and the stream survives.
      expect(() => normalizeRequestLog(bad as unknown)).not.toThrow();
    }
    expect(normalizeRequestLog(null)).toBeNull();
    expect(normalizeRequestLog("x")).toBeNull();
  });

  it("substitutes defaults for wrong-typed fields instead of propagating them", () => {
    const e = normalizeRequestLog({ ip: 42, method: {}, country: 7, uri: [] })!;
    expect(e.ip).toBe("-");
    expect(e.method).toBe("GET");
    expect(e.country).toBeUndefined();
    expect(e.path).toBe("/");
  });

  it("always produces an id, so a list can key on it", () => {
    expect(normalizeRequestLog(LIVE_FRAME)?.id).toBe("1785797071.741-72896");
    expect(normalizeRequestLog({})?.id).toMatch(/^req-/);
    // Two id-less frames in the same millisecond must not collide.
    const a = normalizeRequestLog({})!.id;
    const b = normalizeRequestLog({})!.id;
    expect(a).not.toBe(b);
  });
});
