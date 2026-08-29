"use client";

/**
 * Real-time request hits, drawn on the choropleth.
 *
 * Fed by the SAME stream the Logs tab tails (`useRequestLogStream` → the edge's
 * `/logs/stream`), so a hit that animates here is a row you can go and read there. Nothing
 * new is collected for this: `site_logger` already resolves one country per request and
 * hands it to both the ring buffer and the live pipe.
 *
 * ── Where a ripple is positioned ────────────────────────────────────────────
 *
 * From `country-paths.json` itself, not from a centroid table and not from the DOM. The
 * vendored paths use only M/L/Z — they are plain polygons — so the centre is arithmetic on
 * the same numbers the map draws, and cannot drift from it. No second asset to generate
 * and keep in step, and no dependency on the element being laid out (`getBBox()` throws on
 * a path that is display:none or detached, which is precisely the fixture and
 * server-render case).
 *
 * The centre is that of the LARGEST subpath, not of the whole shape. A country's bounding
 * box is a poor location when it owns distant territory: the box around the mainland USA
 * plus Alaska centres in the Pacific, and France plus French Guiana centres in the
 * Atlantic. Picking the biggest landmass puts the ripple where the country visibly is.
 *
 * ── Why hits are dropped rather than queued ─────────────────────────────────
 *
 * A busy site does thousands of requests a minute. Animating each one would mount
 * thousands of elements, and the interesting information — *where* traffic is coming from
 * right now — is fully conveyed by a sample. So there is a hard cap on concurrent ripples
 * and a per-country cooldown; excess hits increment the counter and are otherwise
 * discarded. The alternative (an unbounded queue) turns a traffic spike into a frozen tab,
 * which is exactly when you most want the tab to work.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import countryPaths from "./country-paths.json";
import { countryNamer } from "./countries";
import { CountryFlag } from "./CountryFlag";

const PATHS = (countryPaths as { paths: Record<string, string> }).paths;

/** code → centre of its largest landmass, in the map's own user units. Lazily filled. */
const CENTRES = new Map<string, { x: number; y: number } | null>();

/**
 * Centre of a country's biggest polygon.
 *
 * Subpaths split on `M`; each one's extent is measured and the widest-by-area wins. Only
 * M/L/Z appear in the vendored atlas, so every number in a subpath is a coordinate and a
 * plain numeric scan is exact rather than an approximation of curve geometry.
 */
export function countryCentre(code: string): { x: number; y: number } | null {
  const cached = CENTRES.get(code);
  if (cached !== undefined) return cached;

  const d = PATHS[code];
  let best: { x: number; y: number; area: number } | null = null;

  if (d) {
    for (const sub of d.split("M")) {
      if (!sub.trim()) continue;
      const nums = sub.match(/-?\d+(?:\.\d+)?/g);
      if (!nums || nums.length < 4) continue;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let i = 0; i + 1 < nums.length; i += 2) {
        const x = Number(nums[i]);
        const y = Number(nums[i + 1]);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      // +epsilon so a perfectly thin sliver still beats nothing at all.
      const area = (maxX - minX + 0.01) * (maxY - minY + 0.01);
      if (!best || area > best.area) {
        best = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, area };
      }
    }
  }

  const centre = best ? { x: best.x, y: best.y } : null;
  CENTRES.set(code, centre);
  return centre;
}

/** Concurrent ripples. Past this, new hits only update counters. */
const MAX_RIPPLES = 18;

/**
 * Presentation speed adapts to the ARRIVAL rate.
 *
 * One fixed cadence cannot serve both ends. A site doing two requests a minute needs each
 * ripple to linger long enough to be noticed at all; a site doing two hundred a second
 * needs them to fire and clear immediately, or the per-country cooldown throttles the
 * display down to a fraction of the real traffic and the map understates what is happening
 * — the opposite of what a live view is for.
 *
 * So both the spacing and the animation length are functions of the measured rate: fast and
 * brief when busy, slower and longer-lived when quiet, interpolated in between.
 */

/** Same-country spacing, ms. Below this a single busy country draws over itself. */
const COOLDOWN_QUIET_MS = 450;
const COOLDOWN_BUSY_MS = 45;

/** Ripple lifetime, ms. Also the CSS animation duration — passed through as a variable. */
const RIPPLE_QUIET_MS = 1600;
const RIPPLE_BUSY_MS = 650;

/** Hits/sec at or below which "quiet" values apply, and at or above which "busy" do. */
const RATE_QUIET = 2;
const RATE_BUSY = 25;

/** How many recent arrivals the rate estimate looks at. Long enough to be steady, short
 *  enough to react within a second or two of traffic changing. */
const RATE_WINDOW = 24;

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Arrival rate → how the display should pace itself.
 *
 * Exported and pure so the curve can be pinned by tests: it is the one piece of this that
 * is easy to get subtly wrong (inverted, or clamped on the wrong side) and impossible to
 * notice by looking, since both ends still animate.
 */
export function pacingFor(ratePerSec: number): { cooldownMs: number; rippleMs: number } {
  const t =
    ratePerSec <= RATE_QUIET
      ? 0
      : ratePerSec >= RATE_BUSY
        ? 1
        : (ratePerSec - RATE_QUIET) / (RATE_BUSY - RATE_QUIET);
  return {
    cooldownMs: lerp(COOLDOWN_QUIET_MS, COOLDOWN_BUSY_MS, t),
    rippleMs: Math.round(lerp(RIPPLE_QUIET_MS, RIPPLE_BUSY_MS, t)),
  };
}

/** Recent-hit feed length beside the map. */
const FEED_LIMIT = 5;

export interface Ripple {
  key: number;
  code: string;
  x: number;
  y: number;
  /** Animation duration for THIS ripple, ms. Fixed at birth so a burst mid-flight doesn't
   *  retime ripples that are already animating. */
  ms: number;
}

export interface LiveHit {
  key: number;
  code?: string;
  path: string;
  statusCode: number;
}

/**
 * Ripple bookkeeping, kept out of the map's render path.
 *
 * Returns a `push` the stream calls per hit and the state the map draws. The map itself
 * re-renders only when a ripple is added or expires, never per frame — the animation is
 * CSS.
 */
export function useLiveHits() {
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [feed, setFeed] = useState<LiveHit[]>([]);
  const [total, setTotal] = useState(0);

  const seq = useRef(0);
  const lastByCountry = useRef(new Map<string, number>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  /** Arrival times of the last RATE_WINDOW hits, for the rate estimate. */
  const recent = useRef<number[]>([]);

  // Every pending expiry has to be cancelled on unmount, or a ripple that outlives the
  // component calls setState on it.
  useEffect(
    () => () => {
      for (const t of timers.current) clearTimeout(t);
      timers.current.clear();
    },
    [],
  );

  const push = useCallback(
    (hit: { country?: string; path: string; statusCode: number }) => {
      const key = ++seq.current;
      setTotal((n) => n + 1);
      setFeed((f) => [{ key, code: hit.country, path: hit.path, statusCode: hit.statusCode }, ...f].slice(0, FEED_LIMIT));

      const now = performance.now();

      // Rate is measured over ALL hits, including ones with no country — it describes how
      // busy the site is, which is what should drive the pace, not how many happen to be
      // drawable.
      const times = recent.current;
      times.push(now);
      if (times.length > RATE_WINDOW) times.shift();
      // Span of the window in seconds; a single sample has no rate yet, so treat it as quiet.
      const span = times.length > 1 ? (now - times[0]) / 1000 : 0;
      const ratePerSec = span > 0 ? (times.length - 1) / span : 0;
      const { cooldownMs: cooldown, rippleMs } = pacingFor(ratePerSec);

      const code = hit.country;
      if (!code) return; // no country (private address, or no GeoIP on the box)

      const last = lastByCountry.current.get(code) ?? 0;
      if (now - last < cooldown) return;

      const centre = countryCentre(code);
      if (!centre) return; // country isn't in the vendored atlas

      lastByCountry.current.set(code, now);
      setRipples((rs) =>
        rs.length >= MAX_RIPPLES ? rs : [...rs, { key, code, ...centre, ms: rippleMs }],
      );

      const t = setTimeout(() => {
        timers.current.delete(t);
        setRipples((rs) => rs.filter((r) => r.key !== key));
      }, rippleMs);
      timers.current.add(t);
    },
    [],
  );

  const reset = useCallback(() => {
    for (const t of timers.current) clearTimeout(t);
    timers.current.clear();
    setRipples([]);
    setFeed([]);
    setTotal(0);
    lastByCountry.current.clear();
    recent.current = [];
  }, []);

  return { ripples, feed, total, push, reset };
}

/** The ripples themselves. Rendered inside the map's translated <g>. */
export const RippleLayer: React.FC<{ ripples: Ripple[] }> = ({ ripples }) => (
  <g className="geo-ripples" aria-hidden>
    {ripples.map((r) => (
      // Two circles: an expanding ring that reads as "a request arrived from here", and a
      // small solid dot so a single hit is still visible after the ring has faded out.
      <g
        key={r.key}
        className="geo-ripple"
        // Duration travels to CSS as a variable rather than being hardcoded there, so the
        // animation and the JS expiry that unmounts the element can never disagree — a
        // shorter animation would leave a dead circle sitting on the map, a longer one
        // would cut the fade off mid-way.
        style={{ transformOrigin: `${r.x}px ${r.y}px`, ["--geo-ripple-ms" as string]: `${r.ms}ms` }}
      >
        <circle className="geo-ripple-ring" cx={r.x} cy={r.y} r={2} />
        <circle className="geo-ripple-dot" cx={r.x} cy={r.y} r={1.1} />
      </g>
    ))}
  </g>
);

/** Recent hits, beside the live toggle. Shows the map isn't merely idle. */
export const LiveHitFeed: React.FC<{ hits: LiveHit[]; locale: string; emptyLabel: string }> = ({
  hits,
  locale,
  emptyLabel,
}) => {
  const nameOf = useMemo(() => countryNamer(locale), [locale]);

  if (hits.length === 0) {
    return <p className="text-xs text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <ul className="space-y-1">
      {hits.map((h) => (
        <li key={h.key} className="flex items-center gap-2 text-xs">
          {h.code ? (
            <CountryFlag code={h.code} title={nameOf(h.code)} />
          ) : (
            <span aria-hidden className="h-3 w-[1.125rem] rounded-sm bg-muted" />
          )}
          <span
            className={`shrink-0 tabular-nums ${
              h.statusCode >= 500
                ? "text-danger"
                : h.statusCode >= 400
                  ? "text-warning"
                  : "text-success"
            }`}
          >
            {h.statusCode}
          </span>
          <span className="truncate text-muted-foreground">{h.path}</span>
        </li>
      ))}
    </ul>
  );
};
