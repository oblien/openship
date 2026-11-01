/**
 * Nonnegative Compose duration strings ("90s", "+90s", ".5s", "1.s") and bare
 * numbers of seconds ("30"), the forms compose's `stop_grace_period` and
 * healthcheck timings take.
 *
 * ONE grammar for every reader. The openship.json parser rejects a value that
 * doesn't match it, the compose parser warns about one, and the runtime treats
 * one as unset (Docker keeps its default). The match is anchored on purpose: a
 * scan for unit groups reads "1m30" as one minute and drops the 30, and "abc5s"
 * as five seconds: a value nobody asked for, applied without a word.
 */
const UNIT_NS: Record<string, number> = {
  ns: 1,
  us: 1_000,
  µs: 1_000,
  μs: 1_000,
  ms: 1_000_000,
  s: 1_000_000_000,
  m: 60_000_000_000,
  h: 3_600_000_000_000,
  d: 86_400_000_000_000,
  w: 604_800_000_000_000,
};

// Compose accepts an optional positive sign and decimal numbers without a
// leading or trailing digit. Derive both readers from the same number/unit
// definitions, so validation cannot reject a form the runtime understands.
const NUMBER_PART = String.raw`(?:\d+(?:\.\d*)?|\.\d+)`;
const UNITS = Object.keys(UNIT_NS).join("|");
const DURATION_RE = new RegExp(`^\\+?(?:${NUMBER_PART}|(?:${NUMBER_PART}(?:${UNITS}))+)$`);
const BARE_SECONDS_RE = new RegExp(`^\\+?${NUMBER_PART}$`);
const DOCKER_DURATION_LIMIT_NS = 2 ** 63;

/** True when the WHOLE string is a duration. No trimming: `" 90s"` is not one. */
export function isComposeDuration(value: string): boolean {
  return value === value.trim() && parseComposeDurationNs(value) !== undefined;
}

/**
 * Nanoseconds (the unit Docker's Engine API takes for healthcheck timings), or
 * undefined when the value is absent, blank, or not a whole duration.
 * Surrounding whitespace is tolerated here, as the runtime always has.
 */
export function parseComposeDurationNs(
  value: string | number | null | undefined,
): number | undefined {
  if (value == null) return undefined;
  const str = String(value).trim();
  if (!str || !DURATION_RE.test(str)) return undefined;
  let total = 0;
  if (BARE_SECONDS_RE.test(str)) {
    total = parseFloat(str) * UNIT_NS.s!;
  } else {
    const groups = new RegExp(`(${NUMBER_PART})(${UNITS})`, "g");
    let m: RegExpExecArray | null;
    while ((m = groups.exec(str)) !== null) {
      total += parseFloat(m[1]!) * UNIT_NS[m[2]!]!;
    }
  }
  const ns = Math.round(total);
  // Docker consumes signed 64-bit nanoseconds. Overflow must not serialize as
  // null (Infinity), or pass validation only to fail at container creation.
  return Number.isFinite(ns) && ns < DOCKER_DURATION_LIMIT_NS ? ns : undefined;
}
