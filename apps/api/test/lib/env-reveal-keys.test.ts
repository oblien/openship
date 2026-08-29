import { describe, expect, it } from "vitest";
import { AppError } from "@repo/core";
import { MAX_REVEAL_KEYS, parseRevealKeys, pickRevealed } from "../../src/lib/env-reveal";

/**
 * Per-key reveal (#336 follow-up): opening ONE row's eye must disclose ONE secret.
 * Before this, every reveal endpoint answered with the source's whole env map, so
 * seeing `SMTP_HOST` also handed the browser `SMTP_PASS` and 30 others.
 *
 * Two properties are locked in here: a reveal request must NAME what it wants
 * (there is no "give me everything" shape), and the response carries nothing but
 * those names.
 */
describe("env reveal keys", () => {
  const env = { NODE_ENV: "production", SMTP_PASS: "s3cret", EMPTY: "" };

  it("returns only the requested keys", () => {
    expect(pickRevealed(env, ["SMTP_PASS"])).toEqual({ SMTP_PASS: "s3cret" });
    expect(pickRevealed(env, ["NODE_ENV", "EMPTY"])).toEqual({ NODE_ENV: "production", EMPTY: "" });
  });

  it("omits keys the source doesn't have, rather than erroring", () => {
    expect(pickRevealed(env, ["NOPE"])).toEqual({});
    expect(pickRevealed(null, ["NODE_ENV"])).toEqual({});
  });

  it("never resolves a key off the prototype chain", () => {
    // `key in env` would answer with Object.prototype.constructor here.
    expect(pickRevealed(env, ["constructor", "toString", "__proto__"])).toEqual({});
  });

  it("rejects a request that names nothing", () => {
    for (const bad of [undefined, null, [], {}, "SMTP_PASS"]) {
      expect(() => parseRevealKeys(bad)).toThrow(AppError);
    }
  });

  it("rejects non-string, empty and oversized key names", () => {
    expect(() => parseRevealKeys(["OK", 1])).toThrow(AppError);
    expect(() => parseRevealKeys([""])).toThrow(AppError);
    expect(() => parseRevealKeys(["x".repeat(513)])).toThrow(AppError);
  });

  it("bounds one request and dedupes", () => {
    expect(parseRevealKeys(["A", "A", "B"])).toEqual(["A", "B"]);
    expect(() => parseRevealKeys(Array.from({ length: MAX_REVEAL_KEYS + 1 }, (_, i) => `K${i}`))).toThrow(
      AppError,
    );
  });

  it("answers 400, not 500 — a bad keys list is a client error", () => {
    try {
      parseRevealKeys([]);
      expect.unreachable();
    } catch (err) {
      expect((err as AppError).statusCode).toBe(400);
    }
  });
});
