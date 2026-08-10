import { describe, expect, it } from "vitest";
import type { LogEntry } from "@repo/adapters";

import {
  MAX_ENTRY_CHARS,
  MAX_TOTAL_CHARS,
  sanitizeLogText,
  sanitizeLogsForPersistence,
  sanitizeStorableStrings,
  sliceWithoutSplittingPair,
} from "../../../src/modules/deployments/build-log-sanitize";

/**
 * `build_session.logs` is jsonb. Postgres REFUSES a jsonb value carrying a NUL
 * ("unsupported Unicode escape sequence") or an unpaired surrogate ("invalid
 * input syntax for type json") — both verified by inserting into a real jsonb
 * column. Raw build output carries the first: a docker exec whose connection
 * upgrade fails surfaces the RAW multiplexed stream in its error message, 8-byte
 * frame headers (0x01 0x00 0x00 0x00 …) and all, and that text is logged
 * verbatim as a build warning. The rejected UPDATE then threw out of onSuccess
 * and a working deploy was recorded failed.
 *
 * The second one this module used to MANUFACTURE: capping an over-long entry with
 * a code-UNIT slice cuts astral characters in half, and the cap ran after the
 * surrogate-repair pass so nothing re-checked it.
 *
 * The property under test is the one Postgres checks: the SERIALIZED payload must
 * contain no \\u0000 escape and no lone surrogate escape — of EITHER half.
 */

const NUL = String.fromCharCode(0);
const SOH = String.fromCharCode(1);
const CR = String.fromCharCode(13);
const ESC = String.fromCharCode(27);
const DEL = String.fromCharCode(127);
/** What dockerode hands back verbatim when the exec upgrade fails. */
const DEMUX_FRAME_HEADER = SOH + NUL + NUL + NUL + NUL + NUL + NUL + String.fromCharCode(47);
const ROCKET = "\u{1F680}";

/**
 * D800–DFFF, high AND low halves. `JSON.stringify` escapes exactly the lone
 * surrogates and emits well-formed pairs literally, so matching this against the
 * serialized payload is precisely Postgres' rule. (Round 1 asserted /\\ud800/ —
 * the live bug emitted \\ud83d and sailed straight past it.)
 */
const LONE_SURROGATE_ESCAPE = /\\u[dD][89a-fA-F][0-9a-fA-F]{2}/;

/** Non-null when a real jsonb column would reject this value. */
function jsonbRejection(value: unknown): string | null {
  const serialized = JSON.stringify(value ?? null);
  if (serialized.includes("\\u0000")) return "unsupported Unicode escape sequence";
  if (LONE_SURROGATE_ESCAPE.test(serialized)) return "invalid input syntax for type json";
  return null;
}

const entry = (message: string, extra: Partial<LogEntry> = {}): LogEntry => ({
  timestamp: "2026-08-01T07:02:30.341Z",
  message,
  level: "info",
  ...extra,
});

describe("the jsonb-rejection oracle itself", () => {
  it("matches what Postgres actually refuses", () => {
    expect(jsonbRejection([{ message: `a${NUL}b` }])).toContain("Unicode escape");
    expect(jsonbRejection([{ message: `a${String.fromCharCode(0xd83d)}b` }])).toContain(
      "invalid input syntax",
    );
    // A LOW half alone is just as fatal, and is what a cut before the pair leaves.
    expect(jsonbRejection([{ message: `a${String.fromCharCode(0xdc00)}b` }])).toContain(
      "invalid input syntax",
    );
    expect(jsonbRejection([{ message: `emoji ${ROCKET} ok` }])).toBeNull();
  });
});

describe("sliceWithoutSplittingPair", () => {
  it("cuts before a pair rather than through it", () => {
    const s = `ab${ROCKET}cd`; // code units: a b HIGH LOW c d
    expect(sliceWithoutSplittingPair(s, 3)).toBe("ab");
    expect(sliceWithoutSplittingPair(s, 4)).toBe(`ab${ROCKET}`);
    expect(sliceWithoutSplittingPair(s, 5)).toBe(`ab${ROCKET}c`);
    expect(sliceWithoutSplittingPair(s, 99)).toBe(s);
  });

  it("leaves no lone surrogate at ANY cut point", () => {
    const s = `${ROCKET}a${ROCKET}${ROCKET}b${ROCKET}`;
    for (let max = 1; max <= s.length + 2; max++) {
      expect(sliceWithoutSplittingPair(s, max).isWellFormed()).toBe(true);
    }
  });
});

describe("sanitizeLogText", () => {
  it("strips the NUL bytes a docker demux frame header injects", () => {
    const raw = `Warning: app prepare step "adminKey" failed: (HTTP code 101) unexpected — Admin key: ${DEMUX_FRAME_HEADER}convex-self-hosted|01da`;
    const out = sanitizeLogText(raw);
    expect(out).not.toContain(NUL);
    expect(out).not.toContain(SOH);
    expect(out).toContain("Admin key: /convex-self-hosted|01da");
  });

  it("keeps tab, newline and ESC but drops CR and DEL", () => {
    // ESC survives because the stored copy is replayed into xterm; dropping it
    // would strip the colour the live stream showed.
    const out = sanitizeLogText(`a\tb\nc${CR}d${ESC}[31me${DEL}f`);
    expect(out).toBe(`a\tb\ncd${ESC}[31mef`);
  });

  it("replaces a lone surrogate of EITHER half and keeps valid pairs", () => {
    expect(sanitizeLogText(`half ${String.fromCharCode(0xd800)} here`)).toBe("half � here");
    expect(sanitizeLogText(`half ${String.fromCharCode(0xd83d)} here`)).toBe("half � here");
    expect(sanitizeLogText(`half ${String.fromCharCode(0xdc00)} here`)).toBe("half � here");
    const pair = `emoji ${ROCKET} done`;
    expect(sanitizeLogText(pair)).toBe(pair);
  });

  it("leaves clean multi-byte output untouched", () => {
    const clean = "→ Services require the Docker runtime — ✓ 中文";
    expect(sanitizeLogText(clean)).toBe(clean);
  });

  it("truncates a single oversized line and says so", () => {
    const out = sanitizeLogText("x".repeat(MAX_ENTRY_CHARS + 500));
    expect(out.length).toBeLessThan(MAX_ENTRY_CHARS + 100);
    expect(out).toContain("500 more character(s) truncated for storage");
  });

  it("never leaves a lone surrogate at the truncation boundary", () => {
    // Round 1 sliced on a code-UNIT index and ran the cap AFTER the repair pass,
    // so this MANUFACTURED the second payload Postgres rejects. Asserted across
    // the whole neighbourhood of the cut, not one offset: the field bug landed on
    // exactly one of these.
    for (let offset = -4; offset <= 4; offset++) {
      const line = `${"a".repeat(MAX_ENTRY_CHARS + offset)}${ROCKET} rocket tail`;
      const out = sanitizeLogText(line);
      expect(out.isWellFormed(), `offset ${offset}`).toBe(true);
      expect(jsonbRejection([{ message: out }]), `offset ${offset}`).toBeNull();
      expect(out, `offset ${offset}`).toContain("more character(s) truncated for storage");
      // The announced count must stay honest after the boundary adjustment.
      const dropped = Number(/\[(\d+) more character/.exec(out)?.[1]);
      expect(line.length - dropped, `offset ${offset}`).toBe(
        out.length - `… [${dropped} more character(s) truncated for storage]`.length,
      );
    }
  });

  it("cannot emit a lone surrogate for a line that is BOTH hostile and oversized", () => {
    // The dropped NULs shift everything left, so the pair straddles the cap only
    // AFTER stripping — the cut must be pair-safe on the cleaned string, not the
    // raw one.
    const line = `${NUL.repeat(100)}${"b".repeat(MAX_ENTRY_CHARS - 1)}${ROCKET} tail`;
    const out = sanitizeLogText(line);
    expect(out).not.toContain(NUL);
    expect(out.isWellFormed()).toBe(true);
    expect(jsonbRejection([{ message: out }])).toBeNull();
  });
});

describe("sanitizeStorableStrings", () => {
  it("cleans nested strings and leaves everything else alone", () => {
    const when = new Date("2026-08-01T00:00:00.000Z");
    const out = sanitizeStorableStrings({
      deployWarning: `crashed${NUL}raw`,
      port: 3000,
      ok: true,
      at: when,
      nested: { list: [`a${NUL}`, 2, null] },
    });
    expect(jsonbRejection(out)).toBeNull();
    expect(out.port).toBe(3000);
    expect(out.ok).toBe(true);
    expect(out.at).toBe(when);
    expect(out.nested.list).toEqual(["a", 2, null]);
  });

  it("cleans an oversized value without splitting a pair", () => {
    // A compose `environment:` value is user data and lands in deployment.meta.
    const out = sanitizeStorableStrings({
      env: { SEED: `${"z".repeat(MAX_ENTRY_CHARS - 1)}${ROCKET}` },
    });
    expect(jsonbRejection(out)).toBeNull();
  });

  it("passes undefined and null through", () => {
    expect(sanitizeStorableStrings(undefined)).toBeUndefined();
    expect(sanitizeStorableStrings(null)).toBeNull();
  });
});

describe("sanitizeLogsForPersistence", () => {
  it("produces a payload Postgres can store as jsonb", () => {
    const out = sanitizeLogsForPersistence([
      entry(`Admin key: ${DEMUX_FRAME_HEADER}convex-self-hosted|01da`),
      entry("clean line", { serviceName: `backend${NUL}` }),
    ]);
    expect(jsonbRejection(out)).toBeNull();
    expect(JSON.parse(JSON.stringify(out))).toHaveLength(2);
    expect(out[1].serviceName).toBe("backend");
  });

  it("stores an oversized entry whose astral char straddles the cap", () => {
    // The exact end-to-end repro: round 1 returned a payload a real jsonb column
    // rejected with "invalid input syntax for type json", which shed the WHOLE
    // build log via the repo's marker retry — worse than before the fix.
    const out = sanitizeLogsForPersistence([
      entry(`${"a".repeat(MAX_ENTRY_CHARS - 1)}${ROCKET} done`),
    ]);
    expect(jsonbRejection(out)).toBeNull();
    expect(out[0].message.isWellFormed()).toBe(true);
  });

  it("returns the same entry objects when nothing needed changing", () => {
    const clean = [entry("all good"), entry("still good", { serviceName: "api" })];
    const out = sanitizeLogsForPersistence(clean);
    expect(out[0]).toBe(clean[0]);
    expect(out[1]).toBe(clean[1]);
  });

  it("drops the MIDDLE of an oversized payload, keeps both ends + step events, and marks the cut", () => {
    const chunk = "y".repeat(MAX_ENTRY_CHARS);
    const entries: LogEntry[] = [entry("FIRST LINE")];
    // Comfortably past the whole-payload budget so the middle really is cut.
    const chunks = Math.ceil(MAX_TOTAL_CHARS / MAX_ENTRY_CHARS) * 2;
    for (let i = 0; i < chunks; i++) entries.push(entry(chunk));
    entries.splice(3, 0, entry("build ok", { step: "build", stepStatus: "completed" }));
    entries.push(entry("LAST LINE"));

    const out = sanitizeLogsForPersistence(entries);
    expect(out.length).toBeLessThan(entries.length);
    expect(out[0].message).toBe("FIRST LINE");
    expect(out[out.length - 1].message).toBe("LAST LINE");
    expect(out.some((e) => e.step === "build")).toBe(true);
    expect(out.filter((e) => e.message.includes("omitted from the stored copy"))).toHaveLength(1);
  });
});
