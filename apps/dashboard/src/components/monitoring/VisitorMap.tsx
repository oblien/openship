"use client";

/**
 * Visitors-by-country choropleth plus a ranked list.
 *
 * No mapping library: `country-paths.json` holds one pre-projected SVG path per
 * ISO-3166-1 alpha-2 code (equirectangular, 360x180 viewBox), generated at
 * maintainer time by scripts/update-world-map.mjs. A choropleth needs nothing more
 * than that, and d3-geo + topojson + a runtime projection would add three
 * dependencies and a second theming surface for a static picture.
 *
 * The ranked list is not decoration. Exact values are unreadable off a colour
 * ramp — the map answers "where", the list answers "how many".
 *
 * Two colourings, the user's choice: FLAG (the default — each country in its own flag's
 * hue, so the map is readable as a map) and THEME (one ramp off `--color-primary`, which
 * tracks the active palette like every other chart surface).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Globe, Info, List } from "lucide-react";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { AnalyticsGeoResponse } from "@/hooks/useProjectEndpoints";
import countryPaths from "./country-paths.json";
import countryHues from "./country-hues.json";
import "./monitoring.css";
import { countryNamer } from "./countries";
import { CountryFlag } from "./CountryFlag";
import { formatCount } from "./format";
import { CountryDonut, type DonutSlice } from "./CountryDonut";
import { CHART_TOOLTIP_STYLE } from "@/lib/chart-theme";
import { LiveHitFeed, RippleLayer, countryCentre, type LiveHit } from "./LiveHits";

const PATHS = (countryPaths as { paths: Record<string, string> }).paths;

/**
 * ISO alpha-2 → the dominant hue of that country's flag, precomputed from the same
 * `country-flag-icons` SVGs the legend renders (scripts/update-country-hues.mjs).
 *
 * The BASE hue only — `resolveHues` nudges it where two countries would otherwise come out
 * the same colour, and saturation and lightness are imposed in CSS (per theme), because
 * real flag colours at their real saturations side by side are a clown map.
 */
const HUES = (countryHues as { hues: Record<string, number> }).hues;

/**
 * The custom properties a fill needs. All four travel together because the ELEMENT can't
 * know which the cascade will use — that depends on the colouring mode and the theme,
 * both of which are resolved in CSS.
 */
export interface GeoVars {
  /** Theme-mode: how much `--color-primary` to mix in. */
  "--geo-mix": string;
  /** Flag hue, or undefined when the flag had no chromatic colour. */
  "--geo-hue"?: number;
  /** Flag-mode lightness for light themes. */
  "--geo-l"?: string;
  /** Flag-mode lightness for dark themes — inverted; see lightnessDarkFor. */
  "--geo-l-dark"?: string;
}

/** How many rows the list shows before it stops. The remainder is COUNTED in a
 *  trailing line rather than dropped — a capped list that looks complete misleads. */
const LIST_LIMIT = 12;

/**
 * How many ranks the colour ramp resolves before flattening out. Tied to the legend
 * length on purpose: a shade is only worth distinguishing if the key names the country
 * it belongs to.
 */
const RAMP_SPAN = LIST_LIMIT;

/** Every custom property a rank needs, in either colouring mode and either theme. */
function varsForRank(rank: number, hue?: number): GeoVars {
  return {
    "--geo-mix": mixFor(rank),
    "--geo-hue": hue,
    "--geo-l": `${lightnessFor(rank)}%`,
    "--geo-l-dark": `${lightnessDarkFor(rank)}%`,
  };
}

/**
 * Minimum separation (degrees) two hues need before the eye stops reading them as the
 * same colour, and how far a hue may drift from its flag's real one to get there.
 *
 * The atlas is full of collisions: 42 flags reduce to hue 349 alone — US, DE, CN, JP and
 * EG land on it EXACTLY — while GB/FR/RU/NO/FI sit within 5° of each other in blue. With
 * only the rank lightness step (~3%) between them, a busy top-12 came out as five
 * identical reds and three identical blues, which defeats the entire point of the mode:
 * you pick flag colouring to tell countries apart, and it failed precisely where there
 * was enough traffic to care.
 *
 * The drift limit is what keeps the shades intact. 28° moves a red from crimson to
 * vermilion — still unmistakably that flag's colour — rather than turning the map into an
 * arbitrary categorical palette where the hue no longer means anything.
 */
const HUE_MIN_GAP = 14;
const HUE_MAX_DRIFT = 28;

/**
 * How many ranks apart two countries have to be before their lightness alone separates
 * them, past which their hues may collide freely. The ramp moves ~3% per rank, so four
 * ranks is ~13% — a visibly different shade of the same colour, which is exactly what the
 * ramp is for. Spreading hues beyond the neighbourhood would spend drift on pairs that
 * were never confusable.
 */
const HUE_NEIGHBOURHOOD = 4;

/** Shortest distance between two hues on the 360° circle (349 and 3 are 14° apart). */
function hueGap(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/**
 * code → the hue its landmass actually gets: the flag's own wherever that reads
 * distinctly, nudged off it by the smallest amount that clears `HUE_MIN_GAP` where it
 * doesn't.
 *
 * Assigned in RANK order, so the busiest country always keeps its true flag hue and each
 * one below yields to the ones above it. Deterministic — same ranking in, same colours
 * out — so the map doesn't reshuffle its palette between polls.
 *
 * Only the ramp's own span is spread. Past `RAMP_SPAN` every country already shares the
 * flattest lightness step, so there is no shade budget left to separate them with and
 * nothing in the legend naming them; they keep their real flag hue.
 *
 * Exported for the test — the invariant (no two near-ranked countries within the gap,
 * nothing drifted past the limit) is arithmetic, and asserting it on rendered markup
 * would mean parsing hues back out of a style attribute.
 */
export function resolveHues(
  codes: string[],
  hues: Record<string, number> = HUES,
): Map<string, number> {
  const out = new Map<string, number>();
  const placed: Array<{ rank: number; hue: number }> = [];

  codes.forEach((code, rank) => {
    const base = hues[code];
    if (base == null) return;
    if (rank >= RAMP_SPAN) {
      out.set(code, base);
      return;
    }

    const near = placed.filter((p) => rank - p.rank <= HUE_NEIGHBOURHOOD);
    const clearance = (hue: number) =>
      near.reduce((min, p) => Math.min(min, hueGap(hue, p.hue)), Infinity);

    let hue = base;
    let best = clearance(base);
    // Candidates walk outward from the flag's own hue in half-gap steps, nearest first,
    // so a hue moves as little as it must. When nothing inside the drift limit clears the
    // gap (a run of same-coloured flags longer than the band can hold), the most
    // separated candidate wins: a tight pair beats an identical one.
    for (
      let off = HUE_MIN_GAP / 2;
      off <= HUE_MAX_DRIFT && best < HUE_MIN_GAP;
      off += HUE_MIN_GAP / 2
    ) {
      for (const cand of [(base + off) % 360, (base - off + 360) % 360]) {
        const c = clearance(cand);
        if (c > best) {
          best = c;
          hue = cand;
        }
        if (best >= HUE_MIN_GAP) break;
      }
    }

    out.set(code, hue);
    placed.push({ rank, hue });
  });

  return out;
}

/** Distinct donut wedges before the tail collapses into one "other". */
const DONUT_SLICES = 6;

/** Sentinel code for the aggregated tail wedge. Not an ISO code, so `nameOf` won't
 *  resolve it — CountryDonut's tooltip falls back to showing it verbatim. */
const OTHER_SLICE = "other";

export type GeoColorMode = "theme" | "flag";

/**
 * FLAG, not theme.
 *
 * Theme colouring is one hue at twelve lightness steps: it shows you the RANKING and
 * nothing else — which country a landmass is has to be read off the legend or a hover.
 * Flag colouring answers "who is that" at a glance, which is the question a world map is
 * on the page to answer. It only became a defensible default once the hues stopped
 * colliding (see `resolveHues`); before that it opened on five indistinguishable reds.
 * Theme stays one click away for anyone who wants the map to match the palette.
 */
const DEFAULT_MODE: GeoColorMode = "flag";

/** Remembered across visits — a colouring preference you have to re-pick every time is
 *  not a preference. Own key, not tied to the UI theme, since it's orthogonal to it. */
const MODE_KEY = "openship.monitoring.geoColorMode";

/**
 * Whether the recent-hit list shows alongside the ripples.
 *
 * OFF by default: the Logs tab already lists requests with far more detail, so repeating a
 * five-row slice of it on top of the map was duplication that also covered South America.
 * The ripples are what this view adds — where traffic is coming from, right now.
 *
 * Own key, remembered, because someone who does want it here wants it every time.
 */
const FEED_KEY = "openship.monitoring.liveFeed";

function initialFeed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(FEED_KEY) === "1";
  } catch {
    return false;
  }
}

function initialMode(): GeoColorMode {
  if (typeof window === "undefined") return DEFAULT_MODE;
  const v = window.localStorage.getItem(MODE_KEY);
  return v === "flag" || v === "theme" ? v : DEFAULT_MODE;
}

interface Props {
  data: AnalyticsGeoResponse | null;
  isLoading: boolean;
  /** Rendered in the header beside the colour toggle — the tab's domain scope picker. */
  domainSelector?: React.ReactNode;
  /**
   * Live-hit plumbing. Absent → no switch is rendered at all, which is what keeps the
   * fixture-driven preview and the static-project case from advertising a stream that has
   * nothing behind it.
   *
   * The map owns the SWITCH but not the subscription: opening the stream needs the
   * projectId and the cloud/self-hosted token branch, both of which live in the tab.
   */
  live?: {
    enabled: boolean;
    onEnabledChange: (on: boolean) => void;
    /** Hits since the switch was turned on. */
    total: number;
    ripples: React.ComponentProps<typeof RippleLayer>["ripples"];
    feed: LiveHit[];
    /** Set while connecting or when the edge refused; shown next to the switch. */
    status?: string | null;
  };
}

/**
 * Rank → 0..1, where 0 is the busiest country.
 *
 * By POSITION, not by share: real traffic is heavily skewed (one country is usually most
 * of it), so ramping on absolute share collapses the entire long tail into one shade.
 *
 * The denominator is FIXED at `RAMP_SPAN` rather than being the country count, and rank
 * is clamped to it. Two reasons, both learned the hard way:
 *
 *  - Consistency. The map, the legend swatches and the donut each used to pass their OWN
 *    total (all countries / the listed subset / 6 slices), so one country came out three
 *    different colours — and a key whose colour differs from what it keys is worse than
 *    no key at all. One fixed span is the only way three consumers can agree without
 *    threading the same number through all of them.
 *  - Legibility. Dividing the ramp by 35 countries put the top dozen inside its first
 *    quarter, i.e. a dozen near-identical shades. The tail is all "barely any traffic"
 *    anyway, so collapsing it onto the faintest step loses nothing and gives the ranks
 *    that are actually readable the whole ramp.
 */
function rankT(rank: number): number {
  return Math.min(rank, RAMP_SPAN) / RAMP_SPAN;
}

/**
 * Theme-colouring ramp: how much of `--color-primary` to mix in, 100% → 22%.
 *
 * A MIX percentage rather than an opacity. Opacity composites against whatever is behind
 * the path, which is why the light theme washed out to nothing; a mix produces a solid
 * colour that is still unmistakably from the active palette.
 */
function mixFor(rank: number): string {
  return `${Math.round(100 - rankT(rank) * 78)}%`;
}

/** Flag-colouring lightness for LIGHT themes: busiest darkest (40% → 78%). */
function lightnessFor(rank: number): number {
  return Math.round(40 + rankT(rank) * 38);
}

/**
 * Flag-colouring lightness for DARK themes: busiest BRIGHTEST (70% → 34%).
 *
 * Inverted deliberately. On a light card "most traffic" reads as darkest; on a near-black
 * one the same treatment makes the busiest country the one closest to the background,
 * i.e. the least visible — exactly backwards.
 */
function lightnessDarkFor(rank: number): number {
  return Math.round(70 - rankT(rank) * 36);
}

export const VisitorMap: React.FC<Props> = ({ data, isLoading, domainSelector, live }) => {
  const { t, locale } = useI18n();
  const m = t.projects.monitoring;
  // Localized country names, resolved once per render rather than per <path>.
  const nameOf = useMemo(() => countryNamer(locale), [locale]);

  /**
   * Which colouring the map uses. Independent of the light/dark theme — each mode has a
   * treatment for both, so switching one never forces the other.
   *
   * Read lazily on the client so the stored choice is right on the FIRST paint; a
   * useEffect would flash the default first.
   */
  const [colorMode, setColorMode] = useState<GeoColorMode>(initialMode);
  const [showFeed, setShowFeed] = useState<boolean>(initialFeed);

  const toggleFeed = () => {
    const next = !showFeed;
    setShowFeed(next);
    try {
      window.localStorage.setItem(FEED_KEY, next ? "1" : "0");
    } catch {
      /* private mode — applies for this session */
    }
  };

  /**
   * Hovered country, and where the pointer is inside the map box.
   *
   * Replaces the SVG `<title>` element this used to rely on. A native tooltip takes
   * ~1s to appear, cannot be styled, and renders in the OS chrome — so the map's only
   * per-country readout looked nothing like the chart tooltips beside it.
   */
  const [hover, setHoverState] = useState<string | null>(null);

  /**
   * Hover, with the clear deferred by one task.
   *
   * Crossing a border delivers `pointerout` on the old country then `pointerover` on the
   * new one. Clearing immediately therefore set `null` between them, which UNMOUNTS the
   * tooltip — and a remounted element starts its CSS transition over, so the glide this is
   * all for never happened. Deferring the clear lets the incoming enter cancel it, so the
   * same element simply moves. Leaving for the ocean or off the card has nothing to cancel
   * it, so it still hides.
   */
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setHover = useCallback((code: string | null) => {
    if (clearTimer.current) {
      clearTimeout(clearTimer.current);
      clearTimer.current = null;
    }
    if (code === null) {
      clearTimer.current = setTimeout(() => {
        clearTimer.current = null;
        setHoverState(null);
      }, 0);
      return;
    }
    setHoverState(code);
  }, []);

  // A pending clear must not fire into an unmounted component.
  useEffect(
    () => () => {
      if (clearTimer.current) clearTimeout(clearTimer.current);
    },
    [],
  );

  /**
   * Clicked country, or null. Dims every other country, its legend row and its donut
   * slice — a focus gesture, not a data filter: the totals in the header stay describing
   * the whole window, because silently rescoping them on a click would be a different
   * (and unrequested) feature.
   */
  const [selected, setSelected] = useState<string | null>(null);
  const chooseMode = (mode: GeoColorMode) => {
    setColorMode(mode);
    try {
      window.localStorage.setItem(MODE_KEY, mode);
    } catch {
      // Private mode / storage disabled. The choice still applies for this session.
    }
  };

  const { vars, ranked, donutSlices } = useMemo(() => {
    const all = data?.countries ?? [];
    /**
     * code → the custom properties its fill needs. Keyed by rank in the FULL ranked list,
     * not in the drawable subset: a country with no path in the atlas still occupies a
     * rank in the legend, and skipping it would shift every colour below it so the map
     * and the list disagreed.
     */
    const byCode = new Map<string, GeoVars>();
    // Resolved over the whole ranked list at once — a per-country lookup can't know what
    // the countries above it already took.
    const hueOf = resolveHues(all.map((c) => c.code));
    all.forEach((c, i) => byCode.set(c.code, varsForRank(i, hueOf.get(c.code))));

    // The donut shows the top slices plus one "other" wedge. A ring of 60 hairline
    // slices conveys nothing, and dropping the tail silently would make the shares
    // add up to less than the total the hole reports.
    const top = all.slice(0, DONUT_SLICES);
    const tailCount = all.slice(DONUT_SLICES).reduce((sum, c) => sum + c.count, 0);
    // The very same entry the landmass and the swatch use — not a parallel computation
    // over the slice count, which is how the donut ended up on its own colour scale.
    const slices: DonutSlice[] = top.map((c) => ({
      code: c.code,
      count: c.count,
      vars: byCode.get(c.code) ?? varsForRank(0, hueOf.get(c.code)),
      hasHue: hueOf.has(c.code),
    }));
    // The tail wedge is deliberately hueless — "other" is not a country and must not
    // borrow one's colour. It takes the faintest theme mix instead.
    if (tailCount > 0) {
      slices.push({
        code: OTHER_SLICE,
        count: tailCount,
        vars: { "--geo-mix": "18%" },
        hasHue: false,
      });
    }

    return { vars: byCode, ranked: all, donutSlices: slices };
  }, [data]);

  /**
   * Where the tooltip sits: over the hovered country, in PERCENT of the map box.
   *
   * Anchored to the country rather than to the pointer, which is what makes it smooth.
   * Following the mouse meant `onPointerMove` on every path — each event doing a
   * `getBoundingClientRect()` (a forced synchronous layout) and a `setState` that
   * re-rendered 173 paths, the donut and the legend. At pointer rate that is ~60
   * full re-renders a second for a tooltip whose CONTENT only changes when you cross a
   * border. Now state changes once per country, and the position is arithmetic on the
   * viewBox — no layout read at all.
   *
   * Declared ABOVE the isLoading return with every other hook: it used to live down by
   * its JSX, so the first render after the fetch resolved called one more hook than the
   * skeleton render did — "change in the order of Hooks called by VisitorMap".
   */
  const hoverAt = useMemo(() => {
    if (!hover) return null;
    const c = countryCentre(hover);
    if (!c) return null;
    // viewBox is 0 0 360 165 with the group shifted up 6 to crop Antarctica.
    return { left: (c.x / 360) * 100, top: ((c.y - 6) / 165) * 100 };
  }, [hover]);

  if (isLoading) {
    // bg-card shell with solid bg-muted blocks — an outline-only scaffold reads as
    // a broken layout rather than as loading.
    return (
      <div className="rounded-2xl bg-card p-5">
        <div className="mb-4 h-4 w-40 rounded bg-muted" />
        <div className="h-56 w-full rounded-xl bg-muted" />
        <div className="mt-4 space-y-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-4 w-full rounded bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  const hasCountries = ranked.length > 0;
  const hoveredRow = hover ? ranked.find((c) => c.code === hover) : undefined;

  return (
    <div
      className="rounded-2xl bg-card p-5"
      data-geo-mode={colorMode}
      data-geo-selected={selected ?? undefined}
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Globe className="size-4 text-primary" />
            <h3 className="text-sm font-medium text-foreground">{m.visitorsTitle}</h3>
          </div>
          {hasCountries && (
            <p className="mt-1 text-xs text-muted-foreground">
              {interpolate(m.visitorsSubtitle, {
                total: formatCount(data?.total ?? 0),
                countries: String(ranked.length),
              })}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {live && hasCountries && (
            /* Same shell as the Theme/Flags group below — `rounded-lg bg-muted/50 p-0.5`
               with an active `rounded-md` pill inside. It was a bordered pill with its own
               border colour, which made two controls sitting side by side look like they
               came from different designs; the border also fought the card edge in light
               mode. Now both controls are the same object with different contents. */
            <div className="flex items-center rounded-lg bg-muted/50 p-0.5">
              <button
                type="button"
                onClick={() => live.onEnabledChange(!live.enabled)}
                aria-pressed={live.enabled}
                title={m.liveHitsHint}
                className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
                  live.enabled
                    ? "bg-card text-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {/* The pulsing dot IS the live indicator, so the Radio glyph that used to
                    sit beside it was a third redundant signal in a control this small.
                    Pulses only while streaming — a static dot next to the word "Live" is
                    indistinguishable from a working one. */}
                <span className="relative flex size-1.5 shrink-0">
                  {live.enabled && (
                    <span className="absolute inline-flex size-full animate-ping rounded-full bg-info opacity-75" />
                  )}
                  <span
                    className={`relative inline-flex size-1.5 rounded-full ${
                      live.enabled ? "bg-info" : "bg-muted-foreground/40"
                    }`}
                  />
                </span>
                {m.liveHits}
                {live.enabled && live.total > 0 && (
                  <span className="tabular-nums text-muted-foreground">
                    {formatCount(live.total)}
                  </span>
                )}
              </button>
              {/* Second segment in the SAME shell, so it reads as part of the Live control
                  rather than a third floating button — and only while streaming, since it
                  governs something that only exists then. */}
              {live.enabled && (
                <button
                  type="button"
                  onClick={toggleFeed}
                  aria-pressed={showFeed}
                  title={m.liveFeedHint}
                  aria-label={m.liveFeed}
                  className={`ml-0.5 rounded-md p-1 transition-colors ${
                    showFeed
                      ? "bg-card text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <List className="size-3.5" />
                </button>
              )}
            </div>
          )}
          {domainSelector}
          {hasCountries && (
            <div className="flex items-center gap-0.5 rounded-lg bg-muted/50 p-0.5">
              {(["theme", "flag"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => chooseMode(mode)}
                  aria-pressed={colorMode === mode}
                  className={`rounded-md px-2 py-1 text-xs transition-colors ${
                    colorMode === mode
                      ? "bg-card text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {mode === "theme" ? m.colorTheme : m.colorFlag}
                </button>
              ))}
            </div>
          )}
        {!!data?.visitorDays && (
          <div className="text-right">
            {/* Deliberately NOT labelled "visitors": this is per-day distinct summed
                over the window, so a returning visitor counts once per day. The
                tooltip carries the exact-for-one-day figure, which is the lower
                bound. Overstating this is the same mistake as the old "unique IPs"
                that was really a request count. */}
            <p
              className="text-lg font-semibold text-foreground"
              title={interpolate(m.peakDayTooltip, {
                peak: formatCount(data.peakDayVisitors),
              })}
            >
              {formatCount(data.visitorDays)}
            </p>
            <p className="text-xs text-muted-foreground">
              {m.visitorDays}
              {data.approximate ? ` · ${m.approximate}` : ""}
            </p>
          </div>
        )}
        </div>
      </div>

      {/* An unresolvable edge and a quiet site both produce zero countries. Saying
          which is the difference between "nothing happened" and "something is
          broken" — the failure mode this whole surface existed with for months. */}
      {data && !data.geoAvailable ? (
        <div className="flex items-start gap-2 rounded-xl bg-muted/50 px-4 py-3">
          <Info className="mt-0.5 size-4 shrink-0 text-warning" />
          <div>
            <p className="text-sm font-medium text-foreground">{m.geoUnavailableTitle}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{m.geoUnavailableBody}</p>
          </div>
        </div>
      ) : !hasCountries ? (
        /* No map when there is nothing on it. A full-width featureless grey world beside
           the words "no country data" is worse than the sentence alone — it reads as a
           broken render, and it costs a screen of scrolling to say nothing. */
        <p className="py-6 text-center text-sm text-muted-foreground">{m.noCountries}</p>
      ) : (
        /* Map FULL WIDTH, breakdown beneath it.
           It was a 1.35fr column beside the legend, which gave a world map about half the
           card — too small to pick a country out of — while stranding a mostly-empty
           column next to it. Nothing about a world map wants to be narrow. */
        <div className="space-y-5">
          <div
            className="relative overflow-hidden rounded-xl bg-muted/20"
            onPointerLeave={() => setHover(null)}
          >
            {/* Inside the map box, bottom-left — over ocean at every aspect ratio, and
                close to the ripples it explains. Only while streaming: an empty feed
                permanently parked on the map is furniture. */}
            {live?.enabled && showFeed && (
              <div className="pointer-events-none absolute bottom-2 left-2 z-10 max-w-[14rem] rounded-lg border border-border/40 bg-card/80 p-2 backdrop-blur-sm">
                <LiveHitFeed hits={live.feed} locale={locale} emptyLabel={m.liveHitsWaiting} />
              </div>
            )}
            <svg
              viewBox="0 0 360 165"
              className="h-auto w-full"
              role="img"
              aria-label={m.visitorsTitle}
              // Holes (enclaves, lakes) are separate subpaths in the same `d`, so the
              // nonzero default would fill them in.
              style={{ fillRule: "evenodd" }}
            >
              {/* Crop ~15 units off the bottom: Antarctica is a sixth of an
                  equirectangular map's height, never has visitors, and squashes every
                  populated latitude to make room for itself. */}
              <g transform="translate(0,-6)">
                {Object.entries(PATHS).map(([code, d]) => {
                  const v = vars.get(code);
                  return (
                    <path
                      key={code}
                      d={d}
                      className="geo-country"
                      // A stable handle on a landmass. The paths are otherwise
                      // distinguishable only by their `d`, so hover and selection had no
                      // way to be driven in a browser test — and those two are exactly
                      // the behaviours markup assertions cannot see.
                      data-country={code}
                      // Selector hooks, not values — CSS reads the numbers from the
                      // custom properties. `data-lit` marks a country with traffic;
                      // `data-hue` marks one whose flag yielded a usable hue. Absent on
                      // unlit countries so they keep the flat wash in every mode.
                      data-lit={v ? "" : undefined}
                      data-hue={v?.["--geo-hue"] != null ? "" : undefined}
                      style={v as React.CSSProperties | undefined}
                      data-selected={selected === code ? "" : undefined}
                      // Hairline separators only between LIT countries; drawing borders
                      // across the whole unlit world turned the map into grey static.
                      stroke={v ? "var(--color-card)" : "none"}
                      strokeWidth={0.4}
                      // Only lit countries are interactive: hovering an empty landmass
                      // would pop a tooltip with nothing in it.
                      // ENTER, not move: the tooltip's content is per-country, so there is
                      // nothing to recompute while the pointer travels within one.
                      onPointerEnter={v ? () => setHover(code) : undefined}
                      // Leave is on EVERY path, lit or not. Ocean is not a path at all, so
                      // without this, sliding off a country onto water left the tooltip
                      // stranded until the pointer exited the whole card. Spec order is
                      // leave-then-enter when crossing between siblings, so moving directly
                      // to another country still lands on the new code.
                      onPointerLeave={() => setHover(null)}
                      onClick={v ? () => setSelected((cur) => (cur === code ? null : code)) : undefined}
                    />
                  );
                })}
                {/* Last in the group, so a ripple paints over its own landmass rather
                    than under it. Inside the same translated <g> as the paths, which is
                    why the getBBox() coordinates need no Antarctica-crop compensation. */}
                {live?.enabled && <RippleLayer ripples={live.ripples} />}

              </g>
            </svg>

            {/* Styled to match the chart tooltips exactly — same CHART_TOOLTIP_STYLE on the
                panel, so background, border and per-theme shadow can't drift apart. The
                stacking order lives on this positioning wrapper (`.geo-tooltip`), the way
                recharts' charts get theirs from `.recharts-tooltip-wrapper`.

                Positioned in PERCENT of the box and centred over the country, so it needs
                no measurement and no clamping-by-magic-number (the previous version had a
                hardcoded `1000` and `520`, which only made sense at one card width). The
                `-50%` keeps it centred; `geo-tooltip` adds the transition that turns
                crossing a border into a glide rather than a jump. */}
            {hoveredRow && hoverAt && (
              <div
                className="geo-tooltip pointer-events-none absolute"
                style={{
                  left: `${hoverAt.left}%`,
                  top: `${hoverAt.top}%`,
                  // Clamped to the box so a country near an edge doesn't push it outside.
                  transform: `translate(${hoverAt.left > 78 ? "-100%" : hoverAt.left < 22 ? "0%" : "-50%"}, -115%)`,
                }}
              >
                <div style={CHART_TOOLTIP_STYLE}>
                  <div className="mb-1 flex items-center gap-2">
                    <CountryFlag code={hoveredRow.code} title={nameOf(hoveredRow.code)} />
                    <span className="text-xs font-medium text-foreground">
                      {nameOf(hoveredRow.code)}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {interpolate(m.tooltipRequests, {
                      count: formatCount(hoveredRow.count),
                      pct: hoveredRow.pct.toFixed(1),
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Donut left, legend filling the rest. Beneath the map, so the map gets the
              full width and the numbers still sit next to their key. */}
          <div className="grid gap-5 sm:grid-cols-[180px_minmax(0,1fr)]">
            {/* "How concentrated is this" reads instantly off angle and not at all off a
                choropleth, where visual weight is land area — Russia looks like a huge
                share at any percentage. */}
            <CountryDonut
                selected={selected} slices={donutSlices} total={data?.total ?? 0} nameOf={nameOf} />

            {/* The legend IS the ranked list, doubling as the donut's key — a separate
                legend plus a separate table would say everything twice. Two columns on
                wide screens so twelve rows don't become twelve lines of scrolling. */}
            <ul className="grid gap-x-6 gap-y-1.5 self-center md:grid-cols-2">
              {ranked.slice(0, LIST_LIMIT).map((c, i) => (
                <li
                  key={c.code}
                  className="geo-legend-row flex cursor-pointer items-center gap-2.5 text-sm transition-opacity"
                  data-selected={selected === c.code ? "" : undefined}
                  onClick={() => setSelected((cur) => (cur === c.code ? null : c.code))}
                  onMouseEnter={() => setHover(null)}
                >
                  {/* Legend swatch — same treatment as the map and the donut. A key
                      whose colour differs from what it keys is worse than no key.
                      Styled by class, not `light-dark()`: that CSS function needs a
                      declared `color-scheme` and keys off the OS preference, so a user
                      on data-theme="dark" with a light OS would get the wrong branch. */}
                  <span
                    aria-hidden
                    className="geo-swatch size-2 shrink-0 rounded-full"
                    // Read off the same resolved vars the landmass uses, not HUES —
                    // keying on the raw flag hue would light the swatch for a country
                    // whose spread hue differs from it.
                    data-hue={vars.get(c.code)?.["--geo-hue"] != null ? "" : undefined}
                    data-selected={selected === c.code ? "" : undefined}
                    style={vars.get(c.code) as React.CSSProperties}
                  />
                  <CountryFlag code={c.code} title={nameOf(c.code)} />
                  <span className="min-w-0 flex-1 truncate text-foreground">{nameOf(c.code)}</span>
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {formatCount(c.count)}
                  </span>
                  <span className="w-12 shrink-0 text-right tabular-nums text-xs text-muted-foreground/70">
                    {interpolate(m.share, { pct: c.pct.toFixed(1) })}
                  </span>
                </li>
              ))}
              {ranked.length > LIST_LIMIT && (
                // Never truncate silently — a capped list that looks complete is a lie
                // about the data.
                <li className="text-xs text-muted-foreground/70">
                  {interpolate(m.moreCountries, { count: String(ranked.length - LIST_LIMIT) })}
                </li>
              )}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
};
