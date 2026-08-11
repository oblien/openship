import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "@/components/i18n-provider";
import { MonitoringView } from "./MonitoringView";
import { TopPathsEmptyState } from "./TopPathsEmptyState";
import { resolveHues } from "./VisitorMap";
import countryHues from "./country-hues.json";
import {
  MOCK_SERVICES,
  MOCK_VARIANTS,
  mockAnalytics,
  mockComposeUsage,
  mockGeo,
  mockGeoUnavailable,
  mockHistoryBuckets,
  mockSingleUsage,
  mockStaticUsage,
} from "./fixtures";

/**
 * Does the Monitoring layout actually RENDER its blocks?
 *
 * This exists because the tab shipped twice on a typecheck alone. A typecheck proves
 * the props line up; it says nothing about whether a block is reachable, and "the
 * analytics aren't showing" is precisely the failure a typecheck can't see.
 *
 * Server-rendered to markup — no jsdom, no testing-library, nothing new installed.
 *
 * CAVEAT that shapes the assertions: recharts' `ResponsiveContainer` measures its
 * parent, and in SSR that width is 0, so no chart SVG is emitted. So these assert on
 * the surrounding CONTENT (country names, status classes, headings, legend rows) —
 * which is what proves a block is present and fed. Chart geometry needs a browser.
 */

const geo = mockGeo();
const analytics = mockAnalytics();
/** The raw per-flag hues, to assert what `resolveHues` did and didn't move. */
const HUES = (countryHues as { hues: Record<string, number | undefined> }).hues;
const history = {
  buckets: mockHistoryBuckets(),
  services: MOCK_SERVICES,
  granularityMinutes: 5,
};

function render(overrides: Partial<React.ComponentProps<typeof MonitoringView>> = {}) {
  return renderToStaticMarkup(
    <I18nProvider>
      <MonitoringView
        analytics={analytics}
        isLoadingAnalytics={false}
        geo={geo}
        isLoadingGeo={false}
        history={history}
        isLoadingHistory={false}
        usage={mockComposeUsage}
        isUsageConnected
        usageError={null}
        onReconnectUsage={() => {}}
        serviceKey={null}
        onServiceKeyChange={() => {}}
        trafficChart={<div data-testid="traffic-chart">TRAFFIC_CHART_HERE</div>}
        topPaths={<div data-testid="top-paths">TOP_PATHS_HERE</div>}
        {...overrides}
      />
    </I18nProvider>,
  );
}

describe("analytics blocks are actually rendered", () => {
  it("renders the traffic chart the caller passed in", () => {
    const html = render();
    // Collapsed by default now (Overview already draws this series), so what must be
    // present is the FOLD, carrying the title and the total — not the chart itself.
    expect(html).toContain("Traffic overview");
    expect(html).toContain('aria-expanded="false"');
    // And the child must genuinely not be mounted: the point is to save the recharts mount
    // and the measurement, not just to hide pixels with CSS.
    expect(html).not.toContain("TRAFFIC_CHART_HERE");
  });

  it("renders the top-paths block", () => {
    expect(render()).toContain("TOP_PATHS_HERE");
  });

  it("renders the visitor map with real country content, not an empty shell", () => {
    const html = render();
    // The legend rows carry localized names — proof the geo data reached the map and
    // was not silently filtered out by the country-path lookup.
    expect(html).toContain("United States");
    expect(html).toContain("Germany");
    // And the choropleth itself: its own viewBox, plus one <path> per country in the
    // vendored atlas (well past the handful lucide icons contribute).
    expect(html).toContain('viewBox="0 0 360 165"');
    expect(html.match(/<path/g)?.length ?? 0).toBeGreaterThan(150);
  });

  it("renders the response mix with the 5xx share visible", () => {
    const html = render();
    expect(html).toContain("5xx");
    expect(html).toContain("2xx");
    // Danger token, not a hardcoded hue — a rising 5xx must read as danger in any theme.
    expect(html).toContain("bg-danger");
  });

  it("renders the stats strip with formatted totals", () => {
    const html = render();
    // 99_356 → "99.4K" via formatCount.
    expect(html).toContain("99.4K");
    expect(html).toContain("17.14 GB");
  });

  it("renders the resources block and its per-service dots", () => {
    const html = render();
    expect(html).toContain("postgres");
    expect(html).toContain("worker");
    // A stopped/restarting service shows a dash, never a fabricated 0%.
    expect(html).toContain("—");
  });

  it("renders scope tabs for a multi-service project", () => {
    const html = render();
    for (const s of MOCK_SERVICES) expect(html).toContain(s.name);
  });
});

describe("resource block visibility", () => {
  /** The resources heading is the marker for the whole block. */
  const RESOURCES_MARKER = "Resource usage";

  it("KEEPS resources for a compose stack", () => {
    expect(render()).toContain(RESOURCES_MARKER);
  });

  it("KEEPS resources for a single-container app — one container is still a workload", () => {
    // The bug this guards: gating on "has service rows" would hide resources for every
    // single-container app, which has none by definition but very much has a container.
    const html = render({
      usage: mockSingleUsage,
      history: { ...history, services: [] },
    });
    expect(html).toContain(RESOURCES_MARKER);
    // No scope tabs though — with one workload the control would be a no-op.
    expect(html).not.toContain("All services");
  });

  it("HIDES resources for a static site — there is no container to measure", () => {
    const html = render({
      usage: mockStaticUsage,
      history: { buckets: [], services: [], granularityMinutes: 5 },
    });
    expect(html).not.toContain(RESOURCES_MARKER);
  });

  it("still shows ANALYTICS for a static site — traffic is the whole point there", () => {
    const html = render({
      usage: mockStaticUsage,
      history: { buckets: [], services: [], granularityMinutes: 5 },
    });
    expect(html).toContain("Traffic overview");
    expect(html).toContain("United States");
    expect(html).toContain("TOP_PATHS_HERE");
  });

  it("KEEPS the block on a transient error so the message and Retry are reachable", () => {
    const html = render({ usage: null, usageError: "Host unreachable" });
    expect(html).toContain("Host unreachable");
  });

  it("HIDES resources when the runtime cannot measure at all", () => {
    const html = render({
      usage: { ...mockStaticUsage, supported: false, reason: "bare deployments" },
    });
    expect(html).not.toContain(RESOURCES_MARKER);
  });
});

describe("layout order and map width", () => {
  it("puts the usage-over-time chart AFTER the traffic and paths blocks", () => {
    const html = render();
    const traffic = html.indexOf("Traffic overview");
    const paths = html.indexOf("TOP_PATHS_HERE");
    const history = html.indexOf("Usage over time");
    expect(traffic).toBeGreaterThan(-1);
    expect(history).toBeGreaterThan(paths);
    expect(history).toBeGreaterThan(traffic);
  });

  it("gives the map the FULL card width, not a column beside the legend", () => {
    const html = render();
    // The old layout put the map in a 1.35fr grid track next to the breakdown. Nothing
    // about a world map wants to be half a card wide.
    expect(html).not.toContain("1.35fr");
  });

  it("omits the map entirely when there are no countries to draw on it", () => {
    // A featureless grey world beside "no country data" reads as a broken render and
    // costs a screen of scrolling to say nothing.
    const html = render({ geo: { ...geo, countries: [], total: 0 } });
    expect(html).toContain("No country data");
    // The map's own viewBox, not `<path>` — lucide icons are paths too.
    expect(html).not.toContain('viewBox="0 0 360 165"');
  });

  it("crops Antarctica out of the projection", () => {
    // A sixth of an equirectangular map's height, never has visitors, and squashes
    // every populated latitude to make room for itself.
    expect(render()).toContain('viewBox="0 0 360 165"');
  });
});

describe("degraded states", () => {
  it("says the edge can't resolve countries instead of drawing an empty map", () => {
    const html = render({ geo: mockGeoUnavailable() });
    expect(html).toContain("Country data unavailable");
    // Traffic is unaffected by a geo failure and must still render.
    expect(html).toContain("Traffic overview");
  });

  it("renders the no-data notice for a project with no traffic yet", () => {
    const html = render({ analytics: null, geo: null, history: null });
    expect(html).toContain("No monitoring data yet");
  });

  it("renders skeletons while loading without throwing", () => {
    const html = render({
      analytics: null,
      geo: null,
      history: null,
      usage: null,
      isLoadingAnalytics: true,
      isLoadingGeo: true,
      isLoadingHistory: true,
    });
    expect(html).toContain("bg-muted");
  });
});

describe("fixture preview — the path that must actually produce a populated page", () => {
  it("every MOCK_VARIANTS entry yields non-null data", () => {
    // The failure this guards: `?mock=` resolving to a variant whose bundle is empty,
    // which renders the same empty states as no data at all and looks like the mock
    // silently doing nothing.
    for (const [name, build] of Object.entries(MOCK_VARIANTS)) {
      const b = build();
      expect(b.analytics, `${name}.analytics`).not.toBeNull();
      expect(b.geo, `${name}.geo`).not.toBeNull();
      expect(b.usage, `${name}.usage`).not.toBeNull();
      expect(b.analytics!.summary.totalRequests, `${name} requests`).toBeGreaterThan(0);
    }
  });

  it("the compose fixture renders a POPULATED page — no empty states anywhere", () => {
    const b = MOCK_VARIANTS.compose();
    const html = renderToStaticMarkup(
      <I18nProvider>
        <MonitoringView
          analytics={b.analytics}
          isLoadingAnalytics={false}
          geo={b.geo}
          isLoadingGeo={false}
          history={b.history}
          isLoadingHistory={false}
          usage={b.usage}
          isUsageConnected
          usageError={null}
          onReconnectUsage={() => {}}
          serviceKey={null}
          onServiceKeyChange={() => {}}
          previewVariant="compose"
          onPreviewChange={() => {}}
          trafficChart={<div>TRAFFIC</div>}
          topPaths={<div>PATHS</div>}
        />
      </I18nProvider>,
    );

    // The three strings from the screenshot that must NOT appear with fixtures on.
    expect(html).not.toContain("No monitoring data yet");
    expect(html).not.toContain("No country data");
    expect(html).not.toContain("No samples yet");
    // And the positives: map drawn, countries listed, resources present.
    expect(html).toContain('viewBox="0 0 360 165"');
    expect(html).toContain("United States");
    expect(html).toContain("Resource usage");
    // Plus the "this is fake" banner, so it can never be mistaken for real data.
    expect(html).toContain("Sample data");
  });

  it("static fixture keeps analytics populated while dropping resources", () => {
    const b = MOCK_VARIANTS.static();
    const html = renderToStaticMarkup(
      <I18nProvider>
        <MonitoringView
          analytics={b.analytics}
          isLoadingAnalytics={false}
          geo={b.geo}
          isLoadingGeo={false}
          history={b.history}
          isLoadingHistory={false}
          usage={b.usage}
          isUsageConnected
          usageError={null}
          onReconnectUsage={() => {}}
          serviceKey={null}
          onServiceKeyChange={() => {}}
          trafficChart={<div>TRAFFIC</div>}
          topPaths={<div>PATHS</div>}
        />
      </I18nProvider>,
    );
    expect(html).not.toContain("Resource usage");
    expect(html).not.toContain("No monitoring data yet");
    expect(html).toContain("United States");
  });

  it("offers the preview button in the empty state, and only in dev", () => {
    const withDev = render({ analytics: null, geo: null, history: null, onPreviewChange: () => {} });
    expect(withDev).toContain("Preview with sample data");
    // No handler (production) → no control at all.
    const withoutDev = render({ analytics: null, geo: null, history: null });
    expect(withoutDev).not.toContain("Preview with sample data");
  });
});

describe("UI defects reported from screenshots", () => {
  it("renders flags as SVGs, not emoji — Windows has no regional-indicator glyphs", () => {
    const html = render();
    // country-flag-icons emits a real <svg> per flag, titled with the country name.
    expect(html).toContain("<title>United States</title>");
    expect(html).toContain("<title>Germany</title>");
    // And no regional-indicator codepoints anywhere (U+1F1E6–U+1F1FF), which is what
    // the old emoji flags were and what Windows cannot draw.
    expect(/[\u{1F1E6}-\u{1F1FF}]/u.test(html)).toBe(false);
  });

  it("lays the response classes out as ROWS so values can't overlap the next label", () => {
    const html = render();
    // The bug: `sm:grid-cols-4` inside a half-width card gave each track ~100px while
    // "86.3K 86.3%" needs more, so the numbers printed over the next class label.
    const mix = html.slice(html.indexOf("Responses"));
    expect(mix).not.toContain("sm:grid-cols-4");
    expect(mix).toContain("space-y-1.5");
  });

  it("does not stretch the responses card to its neighbour's height", () => {
    // Left an empty half-card of dead space under the four rows.
    expect(render()).toContain("self-start rounded-2xl bg-card");
  });

  it("never emits hsl(var(--token)) — the theme stores full colors, so that is invalid", () => {
    // `--primary` resolves to `rgba(0,0,0,.92)`, so `hsl(rgba(...))` is dropped by the
    // browser and the masked icon renders with no background at all. That is why
    // Traffic Overview's icon was missing.
    expect(render()).not.toContain("hsl(var(--");
  });
});

describe("chart tooltips are opaque", () => {
  it("uses the popover token, never the translucent card token", async () => {
    const { CHART_TOOLTIP_STYLE } = await import("@/lib/chart-theme");
    // In the dark themes `--th-card-bg` is rgba(255,255,255,.05) — five percent white.
    // Correct for a card ON a background, fatal for a panel floating OVER a chart: the
    // series showed through and the text was unreadable.
    expect(CHART_TOOLTIP_STYLE.backgroundColor).toContain("var(--color-popover)");
    expect(CHART_TOOLTIP_STYLE.backgroundColor).not.toContain("card");
    // Fully opaque: no color-mix down to a translucent fill. The glass version (popover
    // at 82% + blur) read as a grey slab behind the text instead of the surface every
    // other floating panel uses.
    expect(CHART_TOOLTIP_STYLE.backgroundColor).not.toContain("transparent");
    // `backgroundColor`, not the `background` shorthand: recharts merges its own inline
    // `backgroundColor: #fff` into the same style attribute, and only the same key
    // replaces it outright rather than relying on declaration order.
    expect(CHART_TOOLTIP_STYLE).not.toHaveProperty("background");
    // Shadow CAN be inline because the theme exposes one var that already switches per
    // theme (a shadow heavy enough to read on black is a smudge on white).
    expect(CHART_TOOLTIP_STYLE.boxShadow).toBe("var(--th-dropdown-shadow)");
  });

  it("is the SINGLE source every chart uses, so one can't keep the old background", async () => {
    const { readFileSync } = await import("node:fs");
    for (const f of [
      "src/components/monitoring/ResourceHistoryChart.tsx",
      "src/components/monitoring/CountryDonut.tsx",
      "src/components/billing/UsageChart.tsx",
    ]) {
      const src = readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8");
      expect(src, f).toContain("contentStyle={CHART_TOOLTIP_STYLE}");
      // No hand-rolled tooltip background left behind.
      expect(src, f).not.toMatch(/contentStyle=\{\{/);
      // recharts 3 forwards `wrapperClassName` to the CONTENT div, not to the positioned
      // wrapper v2 named. A class of ours there meant `.class > *` styled the label <p>
      // and the item <ul> separately — each got its own blur and shadow, which is what
      // drew the grey band behind the timestamp and a second box around the values.
      expect(src, f).not.toContain("wrapperClassName");
    }
  });
});

describe("choropleth colouring", () => {
  it("emits NO translucent fills — every rank shade is a solid colour", () => {
    const html = render();
    // This is the fix for the wash-out: `fill-opacity` composites against whatever sits
    // behind the path, and over a near-white card there is almost nothing to composite
    // with, so the whole light-mode ramp disappeared. Rank now lives in the colour.
    expect(html).not.toContain("--geo-opacity");
    expect(html).not.toMatch(/fill-opacity="0\./);
    expect(html).not.toMatch(/fillOpacity/);
  });

  it("defaults to FLAG colouring, while still carrying the theme mix ramp", () => {
    const html = render();
    // Theme colouring is one hue at twelve lightness steps — it shows the ranking and
    // nothing else, so the map can't be read as a map without hovering every landmass.
    expect(html).toContain('data-geo-mode="flag"');
    // Both ramps ride on every element regardless of mode: the element can't know which
    // branch the cascade will take. 100% → 22% of --color-primary mixed into
    // --color-muted: solid, and always a shade that belongs to the active palette.
    expect(html).toContain("--geo-mix");
  });

  it("ships BOTH flag lightness ramps, because dark has to invert", () => {
    const html = render();
    // On a light card busiest = darkest. On a near-black one that makes the busiest
    // country the closest to the background, i.e. the least visible — backwards. CSS
    // picks per theme, so the element has to carry both.
    expect(html).toContain("--geo-l:");
    expect(html).toContain("--geo-l-dark:");
  });

  /**
   * Flag hues, de-collided.
   *
   * The atlas maps 42 countries onto hue 349 alone — US, DE, CN and JP land on it
   * EXACTLY, and GB/FR/RU/NO are within 5° of each other in blue. Flag mode used to hand
   * those straight to CSS, so the fixture's top-12 painted five identical reds separated
   * only by the ~3% per-rank lightness step. Now the default mode, so this is the mode
   * everyone opens on.
   *
   * Asserted on the arithmetic rather than the markup: the numbers reach the DOM inside a
   * style attribute, and parsing hues back out of one tests the parser.
   */
  describe("flag hue separation", () => {
    const codes = geo.countries.map((c) => c.code);
    const hues = resolveHues(codes);

    it("leaves the busiest country on its real flag hue", () => {
      // Rank 0 is the one most likely to be recognised by colour, and something has to be
      // the fixed point — everything below yields to the ranks above it.
      expect(hues.get("US")).toBe(349);
    });

    const gapBetween = (a: string, b: string) => {
      const d = Math.abs(hues.get(a)! - hues.get(b)!) % 360;
      return Math.min(d, 360 - d);
    };

    it("separates countries whose lightness step won't tell them apart", () => {
      // RAMP_SPAN — the ranks whose shades the ramp actually resolves and the legend names.
      const ranked = codes.slice(0, 12).filter((c) => hues.has(c));
      const clashes: string[] = [];
      ranked.forEach((a, i) => {
        // HUE_NEIGHBOURHOOD. Beyond four ranks the shades are >13% apart, which is the
        // ramp doing the separating; inside it, hue is all that's left.
        ranked.slice(i + 1, i + 5).forEach((b) => {
          const gap = gapBetween(a, b);
          if (gap < 14) clashes.push(`${a}(${hues.get(a)}) vs ${b}(${hues.get(b)}) = ${gap}°`);
        });
      });
      expect(clashes).toEqual([]);
    });

    it("leaves the tail on its real hues instead of drifting them for nothing", () => {
      // Past the ramp every country shares the faintest lightness step, so there is no
      // shade budget left to separate them with and no legend row naming them — and a
      // bounded drift cannot spread 20+ countries anyway. Chile and Kenya both stay on
      // 349: honest ("that's the flag, and the traffic is negligible") rather than two
      // invented hues that imply a distinction the map isn't making.
      expect(hues.get("CL")).toBe(HUES.CL);
      expect(hues.get("KE")).toBe(HUES.KE);
    });

    it("pulls apart the pairs that made this visible", () => {
      // US/DE: both 349 in the atlas, ranks 0 and 1 — one 3% lightness step apart.
      expect(gapBetween("US", "DE")).toBeGreaterThanOrEqual(14);
      // GB/FR: 222 and 219, ranks 2 and 4. Three degrees of blue is not a distinction.
      expect(gapBetween("GB", "FR")).toBeGreaterThanOrEqual(14);
    });

    it("keeps every hue inside the drift limit, so a red stays a red", () => {
      // HUE_MAX_DRIFT. This is the half of the fix that protects the shades: 28° is
      // crimson→vermilion, not red→orange, so the colour still means "that flag".
      for (const [code, hue] of hues) {
        const raw = HUES[code]!;
        const d = Math.abs(hue - raw) % 360;
        expect(Math.min(d, 360 - d), `${code} drifted from ${raw} to ${hue}`).toBeLessThanOrEqual(28);
      }
    });

    it("hues no country whose flag had no chromatic colour", () => {
      // Singapore's flag reduces to red+white; the atlas records no hue for it, and
      // inventing one would put a country on the map in a colour it doesn't own. Those
      // fall back to the theme wash instead.
      expect(HUES.SG).toBeUndefined();
      expect(hues.has("SG")).toBe(false);
    });
  });

  it("offers a Theme/Flags toggle once there is something to colour", () => {
    expect(render()).toContain("Flags");
    // Hidden when the map isn't drawn — nothing to recolour.
    expect(render({ geo: { ...geo, countries: [], total: 0 } })).not.toContain("Flags");
  });

  it("marks lit countries with data-lit and only hues the ones whose flag had a colour", () => {
    const html = render();
    // Scoped to the MAP: the legend swatches carry data-hue too, so counting across the
    // whole document conflates paths with swatches. Anchored on the map's own viewBox —
    // the FIRST <svg> in the document is the Globe icon in the header.
    const start = html.indexOf('viewBox="0 0 360 165"');
    const svg = html.slice(start, html.indexOf("</svg>", start));
    const paths = (svg.match(/class="geo-country"/g) ?? []).length;
    const lit = (svg.match(/data-lit=""/g) ?? []).length;
    const hued = (svg.match(/data-hue=""/g) ?? []).length;
    expect(paths).toBeGreaterThan(150);
    // ~35 countries have traffic out of 173 drawn.
    expect(lit).toBeGreaterThan(0);
    expect(lit).toBeLessThan(paths / 2);
    // Every hued country must also be lit — a tint on a country with no data implies data.
    expect(hued).toBeLessThanOrEqual(lit);
  });

  it("uses no light-dark() — it needs color-scheme and keys off the OS, not data-theme", () => {
    expect(render()).not.toContain("light-dark(");
  });

  it("colours the donut from the same vars as the map", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./CountryDonut.tsx", import.meta.url), "utf8");
    // Shared type + shared class, so a slice and its landmass cannot diverge.
    expect(src).toContain("GeoVars");
    expect(src).toContain('className="geo-country"');
    // No colour arithmetic of its own.
    expect(src).not.toContain("hsl(");
  });
});

describe("round of screenshot fixes", () => {
  it("light mode ramps --color-info, not the near-black primary", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("./monitoring.css", import.meta.url), "utf8");
    const light = css.slice(0, css.indexOf('[data-theme="dark"]'));
    // Light primary resolves to rgba(0,0,0,.92); mixing THAT toward muted gave a ramp of
    // muddy greys. --info is a real blue (#2563eb) in every theme.
    expect(light).toContain("var(--color-info)");
    // Dark keeps the primary ramp, which the user confirmed reads well.
    expect(css).toContain('[data-theme="dark"] [data-geo-mode="theme"]');
    expect(css.slice(css.indexOf('[data-theme="dark"]'))).toContain("var(--color-primary)");
  });

  it("gives the tooltip a stacking order, on the wrapper recharts actually owns", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(
      new URL("../../styles/chart.css", import.meta.url), "utf8",
    );
    // The donut's centred total is an absolutely-positioned sibling; without this the
    // tooltip painted underneath it. It has to sit on the POSITIONED wrapper — recharts'
    // element — since z-index on the static content div does nothing.
    expect(css).toMatch(/\.recharts-tooltip-wrapper\s*\{[^}]*z-index/);
    // No glass: a blur on the panel (or worse, on each of its children) is what put a
    // smeared grey background behind the tooltip text.
    expect(css).not.toContain("backdrop-filter");
    // The panel's own paint is inline in chart-theme.ts — recharts writes its inline
    // contentStyle defaults into the same attribute, which CSS cannot override.
    expect(css).not.toContain("box-shadow");
  });

  it("keeps the map tooltip in the same stacking order as the chart ones", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("./monitoring.css", import.meta.url), "utf8");
    const geo = css.slice(css.indexOf(".geo-tooltip {"));
    expect(geo.slice(0, geo.indexOf("}"))).toContain("z-index: 40");
  });

  it("renders services as a single-line scroller, not a wrapping grid", () => {
    const html = render();
    const services = html.slice(html.indexOf("Services"));
    // One line that scrolls sideways. A wrapping stack grew the block's height with the
    // service count and pushed the map down; flex-nowrap + overflow-x-auto fixes the height.
    expect(services).toContain("flex-nowrap gap-1.5 overflow-x-auto");
    // The old wrapping-chips container is gone. Named by its exact former class rather than
    // "flex-wrap" in general, because the VisitorMap rendered just below still uses that.
    expect(services).not.toContain("flex flex-wrap gap-1.5");
    expect(services).not.toContain("grid gap-2 sm:grid-cols-2");
    // Status word dropped — the dot carries it; kept reachable in the title.
    expect(html).toContain("web — Running");
  });

  it("makes lit countries clickable and marks the selected one", () => {
    const html = render();
    const svg = html.slice(html.indexOf('viewBox="0 0 360 165"'));
    // Selection is expressed as an attribute so CSS can dim the rest without a re-render
    // of every path's style.
    expect(html).toContain("geo-legend-row");
    expect(svg).toContain("class=\"geo-country\"");
  });

  it("dims non-selected countries via CSS opacity, not by rewriting fills", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("./monitoring.css", import.meta.url), "utf8");
    expect(css).toContain("[data-geo-selected]");
    expect(css).toMatch(/\[data-geo-selected\][^{]*:not\(\[data-selected\]\)/);
  });

  it("drops the native <title> tooltip in favour of a styled one", () => {
    const html = render();
    // Bounded to the MAP's own <svg>: the legend's flag SVGs carry a <title> as their
    // accessible name, which is correct and must not be swept up here.
    const start = html.indexOf('viewBox="0 0 360 165"');
    const svg = html.slice(start, html.indexOf("</svg>", start));
    // A native SVG title takes ~1s to appear, can't be styled, and renders in OS chrome —
    // so the map's readout looked nothing like the chart tooltips beside it.
    expect(svg).not.toContain("<title>");
    expect(svg.length).toBeGreaterThan(1000);
  });

  it("shows the domain picker only when there is more than one domain", () => {
    const one = render({ domains: ["a.com"], onDomainScopeChange: () => {} });
    expect(one).not.toContain("All domains");
    const many = render({ domains: ["a.com", "b.com"], onDomainScopeChange: () => {} });
    expect(many).toContain("All domains");
  });

  it("defaults the domain scope to All", () => {
    const html = render({ domains: ["a.com", "b.com"], onDomainScopeChange: () => {} });
    // The context's selectedDomain defaults to the PRIMARY domain, which silently showed
    // one domain's traffic as the project's. All is the honest default, and it is what the
    // closed trigger must read.
    expect(html).toContain("All domains");
    expect(html).not.toContain("a.com");
  });

  it("uses the app's DomainSwitcher, not a native select", () => {
    const html = render({ domains: ["a.com", "b.com"], onDomainScopeChange: () => {} });
    // A native <select> renders its popup in OS chrome: it ignored the theme entirely and
    // looked nothing like the Theme/Flags toggle beside it. DomainSwitcher is also what
    // the logs header and Overview URL card use, so domains switch the same way app-wide.
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<option");
    // Closed dropdown: the trigger is a button and the hostnames aren't in the DOM yet.
    expect(html).toMatch(/<button[^>]*>[\s\S]*?All domains/);
  });
});

describe("the legend actually keys the map", () => {
  /** Pull every `--geo-mix` the markup sets, tagged with the element that set it. */
  function mixes(html: string) {
    const out: Array<{ mix: string; where: string }> = [];
    for (const m of html.matchAll(/<(path|span|[a-z]+)\b[^>]*?--geo-mix:\s*([0-9]+%)[^>]*>/g)) {
      out.push({ mix: m[2], where: m[1] });
    }
    return out;
  }

  it("gives one country ONE colour everywhere it appears", () => {
    const html = render();
    // The busiest country is drawn as a landmass AND as a legend swatch. Both used to
    // compute the ramp from their own denominator (all countries vs. the listed subset
    // vs. 6 donut slices), so the US came out three different blues.
    const top = mixes(html).filter((e) => e.mix === "100%");
    expect(top.length).toBeGreaterThanOrEqual(2);
    const kinds = new Set(top.map((e) => e.where));
    expect(kinds.has("path")).toBe(true);
    expect(kinds.has("span")).toBe(true);
  });

  it("spends the ramp on the ranks the legend names, not on the long tail", () => {
    const distinct = new Set(mixes(render()).map((e) => e.mix));
    // Dividing by ~35 countries put the visible dozen inside the ramp's first quarter:
    // twelve indistinguishable shades. A fixed span keeps them spread out.
    expect(distinct.size).toBeGreaterThanOrEqual(8);
    const nums = [...distinct].map((v) => parseInt(v, 10));
    expect(Math.max(...nums)).toBe(100);
    expect(Math.min(...nums)).toBeLessThanOrEqual(30);
  });

  it("flattens every country past the ramp span onto the faintest step", () => {
    const html = render();
    const counts = new Map<string, number>();
    for (const e of mixes(html)) counts.set(e.mix, (counts.get(e.mix) ?? 0) + 1);
    // 35 countries, 12 resolved ranks — the other 23 share the floor, which is honest:
    // they are all "barely any traffic".
    const floor = Math.min(...[...counts.keys()].map((v) => parseInt(v, 10)));
    expect(counts.get(`${floor}%`)).toBeGreaterThan(1);
  });
});

describe("selection stays coherent across map, legend and donut", () => {
  it("hands the donut the selected code so its slice can stay lit", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./VisitorMap.tsx", import.meta.url), "utf8");
    const donut = readFileSync(new URL("./CountryDonut.tsx", import.meta.url), "utf8");
    // The wrapper's [data-geo-selected] matches every descendant .geo-country, and the
    // donut's <Cell>s ARE .geo-country — so without this the donut dimmed as a whole,
    // including the wedge for the country being singled out.
    expect(src).toContain("selected={selected}");
    expect(donut).toContain('data-selected={selected === s.code ? "" : undefined}');
  });

  it("dims lit countries less in light themes than in dark ones", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("./monitoring.css", import.meta.url), "utf8");
    const opacities = [...css.matchAll(/\[data-geo-selected\][^{]*\{\s*(?:\/\*[\s\S]*?\*\/\s*)?opacity:\s*([0-9.]+)/g)]
      .map((mm) => Number(mm[1]));
    expect(opacities.length).toBeGreaterThanOrEqual(2);
    // The light ramp's faint end is a pale blue a few percent off the card, so the dark
    // theme's value took the whole map to blank white — you could see which country was
    // selected but no longer which others had any traffic.
    expect(Math.max(...opacities)).toBeGreaterThan(Math.min(...opacities));
    expect(Math.max(...opacities)).toBeGreaterThanOrEqual(0.4);
  });

  it("gives each landmass a stable handle so hover and click can be driven", () => {
    // Paths are otherwise distinguishable only by their `d` attribute.
    expect(render()).toContain('data-country="US"');
  });
});

describe("map hover does not track the pointer", () => {
  /** VisitorMap's source with comments removed. */
  function mapCode(): string {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const raw: string = require("node:fs").readFileSync(
      new URL("./VisitorMap.tsx", import.meta.url),
      "utf8",
    );
    return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  }

  it("binds enter/leave, never pointer-move", () => {
    // React serialises no handler names into markup, so this asserts on the SOURCE — with
    // comments stripped, because the file deliberately EXPLAINS the old approach and a
    // naive substring match would flag its own rationale.
    //
    // The old version ran getBoundingClientRect() (a forced synchronous layout) plus a
    // setState on every pointermove, re-rendering 173 paths at pointer rate for a tooltip
    // whose content only changes when you cross a border. Measured after the fix in a real
    // browser: 200 moves within one country = 0 commits.
    expect(mapCode()).not.toContain("onPointerMove");
    expect(mapCode()).toContain("onPointerEnter");
    expect(mapCode()).not.toContain("getBoundingClientRect");
  });

  it("positions the tooltip from the country, in percent of the box", () => {
    const src = mapCode();
    // Anchored to countryCentre() rather than the cursor. Also removes the hardcoded
    // `1000`/`520` pixel clamps, which only made sense at one card width.
    expect(src).toContain("countryCentre(hover)");
    expect(src).toMatch(/left: `\$\{hoverAt\.left\}%`/);
    expect(src).not.toContain("Math.min(hover.x");
  });

  it("defers the clear so a border crossing keeps the same element", () => {
    const src = mapCode();
    // pointerout(old) then pointerover(new): clearing immediately set null in between,
    // which UNMOUNTED the tooltip — and a remounted node restarts its CSS transition, so
    // the glide never happened. Verified in a browser: same_element=true after a crossing.
    expect(src).toContain("clearTimer");
    expect(src).toMatch(/setHoverState\(null\)/);
  });

  it("clears on leaving any path, so sliding onto ocean hides it", () => {
    const src = mapCode();
    // Ocean is not a path at all, so a lit-only leave handler left the tooltip stranded
    // until the pointer exited the whole card.
    expect(src).toContain("onPointerLeave={() => setHover(null)}");
  });

  it("transitions position instead of recomputing it per frame", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("./monitoring.css", import.meta.url), "utf8");
    expect(css).toContain(".geo-tooltip");
    expect(css).toMatch(/\.geo-tooltip\s*\{[^}]*transition/);
    // Motion-sensitive users get the position change without the slide.
    expect(css).toMatch(/prefers-reduced-motion[\s\S]*?\.geo-tooltip\s*\{\s*transition: none/);
  });
});

describe("responses are reported per exact code", () => {
  it("lists the individual codes under each class", () => {
    const html = render();
    const card = html.slice(html.indexOf("Responses"));
    // The class is the first read; the exact code is the actionable half. Both are in the
    // data all the way from the edge — only this card used to drop the codes.
    for (const code of ["200", "204", "301", "304", "404", "429", "500", "502", "503"]) {
      expect(card).toContain(`>${code}<`);
    }
  });

  it("still shows the class summary, so the glance still works", () => {
    const card = render().slice(render().indexOf("Responses"));
    for (const cls of ["2xx", "3xx", "4xx", "5xx"]) expect(card).toContain(`>${cls}<`);
  });

  it("accounts for codes outside 200-599 instead of losing them in the total", () => {
    // nginx logs 0 when the client disconnects before a response line. Counted in the
    // total but in no class, so without this line the four class shares look like they
    // fail to add up.
    expect(render()).toContain("with no status class");
  });
});

describe("the traffic block folds", () => {
  it("states the total on the fold, so a closed block still answers the question", () => {
    const html = render({ trafficSummary: "99.4K requests" });
    expect(html).toContain("99.4K requests");
    // Height cost while closed: one header row instead of ~300px of chart.
    expect(html).not.toContain("TRAFFIC_CHART_HERE");
  });

  it("is a real button with expanded state, not a div", () => {
    const html = render();
    expect(html).toMatch(/<button[^>]*aria-expanded="false"/);
  });

  it("remembers the choice under its own key", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./MonitoringView.tsx", import.meta.url), "utf8");
    expect(src).toContain("openship.monitoring.trafficOpen");
    // Read lazily in a useState initializer, not a useEffect — an effect renders the
    // default first and then snaps, which on a block this tall is a visible jump on every
    // navigation.
    // Comments stripped: the file deliberately EXPLAINS why it avoids useEffect, and a
    // naive substring match would flag its own rationale.
    const card = readFileSync(new URL("./CollapsibleCard.tsx", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(card).toContain("useState(() => initialOpen(");
    expect(card).not.toContain("useEffect");
  });
});

describe("top paths puts the count on the header line", () => {
  it("no longer spends a third line per row on the count", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../app/(dashboard)/projects/[id]/components/general/TopPaths.tsx", import.meta.url),
      "utf8",
    );
    // The count used to sit on its own line UNDER the bar: five paths cost five extra text
    // lines plus margins, ~90px to carry five numbers, while the header line had empty
    // space across the middle.
    expect(src).toContain("formatCount(path.count)");
    expect(src).not.toContain("topPaths.requests,");
    // Abbreviated in the row, exact in the title — at full precision two numbers plus a
    // long path did not fit on one line in a half-width card.
    expect(src).toContain("path.count.toLocaleString()");
  });
});

describe("resource card structure", () => {
  it("carries liveness in the card subtitle, with no redundant badge on the services row", () => {
    const html = render();
    // Liveness is stated once, by the card subtitle. A second green "Live" pill on the
    // services row was redundant chrome, so a connected stream shows no badge there.
    expect(html).toContain("Live, refreshed every few seconds");
    const services = html.slice(html.indexOf("Services"));
    // Nothing on the row while the stream is up — the offline notice appears only on drop.
    expect(services).not.toContain("Disconnected");
    expect(services).not.toContain("Reconnect");
  });

  it("offers a retry when the stream is down, and does not still say Live", () => {
    const html = render({ isUsageConnected: false });
    expect(html).toContain("Disconnected");
    expect(html).toContain("Reconnect");
    // A static green dot looks identical whether the stream works or died minutes ago, so
    // the disconnected state must change the colour too.
    expect(html).toContain("bg-muted-foreground/40");
  });

  it("wraps each metric in a tile that is not a second card surface", () => {
    const html = render();
    // bg-muted/30, deliberately not bg-card: no theme draws a resting card border, so a
    // card on a card merges into one odd double-padded block.
    expect(html).toContain("rounded-xl bg-muted/30 p-4");
    const tiles = html.match(/rounded-xl bg-muted\/30 p-4/g) ?? [];
    expect(tiles).toHaveLength(4); // cpu, memory, network, disk
  });

  it("draws service chips with no border", () => {
    const html = render();
    const chip = html.slice(html.indexOf('title="web'), html.indexOf('title="web') + 200);
    expect(chip).toContain("rounded-full");
    expect(chip).not.toContain("border");
  });

  it("renders every service in the scroller instead of capping the list", () => {
    const many = {
      ...mockComposeUsage,
      services: Array.from({ length: 14 }, (_, i) => ({
        serviceId: `s${i}`,
        name: `svc-${i}`,
        containerId: `c${i}`,
        status: "running" as const,
        usage: { cpuPercent: 1, memoryMb: 10, diskMb: 0, networkRxBytes: 0, networkTxBytes: 0 },
      })),
    };
    const html = render({ usage: many });
    // No cap, no "+N more": the strip scrolls sideways, so a long list stays one line
    // without hiding anything. Every service is in the DOM, first to last.
    expect(html).not.toContain("+6 more");
    expect(html).not.toContain("Show less");
    expect(html).toContain("svc-0");
    expect(html).toContain("svc-7");
    expect(html).toContain("svc-13");
  });
});

describe("Top Paths is opt-in", () => {
  const render1 = (props: Partial<React.ComponentProps<typeof TopPathsEmptyState>> = {}) =>
    renderToStaticMarkup(
      <I18nProvider>
        <TopPathsEmptyState onEnable={() => {}} {...props} />
      </I18nProvider>,
    );

  it("says WHY it is off, with the measured share", () => {
    const html = render1();
    // "It's expensive" invites doubt; a number is checkable. Measured on the shipped edge
    // image: the path block is 1.72us of the log handler's ~3.0us.
    expect(html).toContain("57%");
    expect(html).toContain("Top Paths is off");
    expect(html).toContain("Enable Top Paths");
  });

  it("carries the same header as the populated card, so enabling fills it rather than replacing it", async () => {
    const { readFileSync } = await import("node:fs");
    const populated = readFileSync(
      new URL("../../app/(dashboard)/projects/[id]/components/general/TopPaths.tsx", import.meta.url),
      "utf8",
    );
    const empty = readFileSync(new URL("./TopPathsEmptyState.tsx", import.meta.url), "utf8");
    // Same lucide glyph in both. Also NOT utils/icons: that file is JSX inside a .js, which
    // the test transform cannot parse, so importing it takes down any test rendering the card.
    expect(populated).toContain('<TrendingUp className="size-5 text-primary" />');
    expect(empty).toContain('<TrendingUp className="size-5 text-primary" />');
    expect(populated).not.toContain("generateIcon");
    expect(empty).not.toContain("generateIcon");
  });

  it("cannot be double-fired while the toggle is in flight", () => {
    const html = render1({ isBusy: true });
    expect(html).toContain("disabled");
    expect(html).toContain("Enabling");
  });

  it("draws its illustration from the shared token family, not hardcoded greys", async () => {
    const { readFileSync } = await import("node:fs");
    const empty = readFileSync(new URL("./TopPathsEmptyState.tsx", import.meta.url), "utf8");
    // Same --th-* family as components/jobs/JobsEmptyState and overview/EmptyState, so an
    // off card reads as part of the app in every theme rather than as a hole in it.
    expect(empty).toContain("var(--th-card-bg)");
    expect(empty).toContain("var(--th-on-12)");
    expect(empty).toContain("var(--th-bd-default)");
  });
});

describe("the recent-hit list is opt-in", () => {
  it("is hidden by default when Live is on — the Logs tab already lists requests", () => {
    const html = render({
      live: { enabled: true, onEnabledChange: () => {}, total: 12, feed: [], ripples: [], status: null },
    });
    // Ripples are what this view adds. A five-row slice of the Logs tab pasted over the map
    // was duplication that also covered South America.
    expect(html).not.toContain("Waiting for requests");
    // The control that reveals it only exists while streaming.
    expect(html).toContain("Recent hits");
  });

  it("offers no list control at all when Live is off", () => {
    const html = render({
      live: { enabled: false, onEnabledChange: () => {}, total: 0, feed: [], ripples: [], status: null },
    });
    expect(html).not.toContain("Recent hits");
  });

  it("remembers the choice under its own key", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./VisitorMap.tsx", import.meta.url), "utf8");
    expect(src).toContain("openship.monitoring.liveFeed");
    // Read in a useState initializer like the colour mode, so the first paint is already
    // right rather than flashing the default.
    expect(src).toContain("useState<boolean>(initialFeed)");
  });
});
