import { describe, it, expect } from "vitest";
import { dedupeServerLogs, getServerLogKey, MAX_SERVER_LOGS } from "./server-log-dedup";

/**
 * The three reported symptoms all live here: duplicated rows (recent + live of one request),
 * unsorted rows (the just-hit endpoint landing mid-list), and — implicitly — that the fix
 * for the first two must not collapse genuinely distinct requests.
 */

const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: undefined,
  timestamp: "2026-08-05T12:00:00.000Z",
  ip: "8.8.8.8",
  method: "GET",
  path: "/",
  statusCode: 200,
  responseTime: 5,
  requestSize: 100,
  responseSize: 200,
  ...over,
});

describe("dedupeServerLogs", () => {
  it("collapses the same request seen via /recent and the live tail (same deterministic id)", () => {
    // The edge stamps `{host}:{seq}`; both sources carry it, so the row must not double up.
    const fromRecent = row({ id: "shop.example.com:42", path: "/orders" });
    const fromLive = row({ id: "shop.example.com:42", path: "/orders" });
    const out = dedupeServerLogs([fromRecent, fromLive]);
    expect(out).toHaveLength(1);
  });

  it("orders newest-first regardless of insertion order", () => {
    const older = row({ id: "h:1", timestamp: "2026-08-05T12:00:00.000Z" });
    const newer = row({ id: "h:2", timestamp: "2026-08-05T12:00:05.000Z" });
    // Appended after the older one (the /recent-then-live path) — must still sort to the top.
    const out = dedupeServerLogs([older, newer]);
    expect(out.map((r) => r.id)).toEqual(["h:2", "h:1"]);
  });

  it("puts a freshly prepended live hit at the top even when merged among older rows", () => {
    const history = [
      row({ id: "h:1", timestamp: "2026-08-05T12:00:01.000Z" }),
      row({ id: "h:2", timestamp: "2026-08-05T12:00:02.000Z" }),
    ];
    const liveHit = row({ id: "h:9", timestamp: "2026-08-05T12:00:09.000Z" });
    // addServerLog prepends; the sort must honour timestamp, not position.
    const out = dedupeServerLogs([liveHit, ...history]);
    expect(out[0].id).toBe("h:9");
  });

  it("does NOT collapse two distinct requests in the same second", () => {
    // The old content key rounded to the whole second and dropped one of these.
    const a = row({ timestamp: "2026-08-05T12:00:00.100Z", path: "/a" });
    const b = row({ timestamp: "2026-08-05T12:00:00.900Z", path: "/b" });
    expect(dedupeServerLogs([a, b])).toHaveLength(2);
  });

  it("collapses true id-less duplicates by full-precision content", () => {
    const a = row({ path: "/same" });
    const b = row({ path: "/same" });
    expect(dedupeServerLogs([a, b])).toHaveLength(1);
  });

  it("never dedups on a random `req-` id — those are per-frame, not identity", () => {
    // Two DIFFERENT requests that each got a random client id must stay separate, keyed on
    // content, not on the meaningless random id.
    const a = row({ id: "req-123-abc", path: "/a" });
    const b = row({ id: "req-456-def", path: "/b" });
    expect(dedupeServerLogs([a, b])).toHaveLength(2);
    // And the same request with two random ids (recent + live, both id-less producers) still
    // collapses because the content key ignores the `req-` id.
    const c = row({ id: "req-123-abc", path: "/dup" });
    const d = row({ id: "req-456-def", path: "/dup" });
    expect(dedupeServerLogs([c, d])).toHaveLength(1);
  });

  it("caps at the newest MAX_SERVER_LOGS after sorting, not the first inserted", () => {
    // Oldest inserted first; the cap must keep the newest, so seq 0 (oldest) is dropped.
    const many = Array.from({ length: MAX_SERVER_LOGS + 5 }, (_, i) =>
      row({ id: `h:${i}`, timestamp: new Date(1785000000000 + i * 1000).toISOString() }),
    );
    const out = dedupeServerLogs(many);
    expect(out).toHaveLength(MAX_SERVER_LOGS);
    expect(out[0].id).toBe(`h:${MAX_SERVER_LOGS + 4}`); // newest
    expect(out.some((r) => r.id === "h:0")).toBe(false); // oldest dropped
  });
});

describe("getServerLogKey", () => {
  it("keys on a deterministic id but not on a random `req-` id", () => {
    expect(getServerLogKey(row({ id: "h:7" }))).toBe("id:h:7");
    expect(getServerLogKey(row({ id: "req-1-x" }))).not.toContain("req-");
  });
});
