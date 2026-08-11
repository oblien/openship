"use client";

/**
 * Country share as a donut.
 *
 * Why it earns its place beside the map: on a choropleth, visual weight is land area,
 * not share — Russia looks like a huge fraction of the world at any percentage, and
 * Singapore is invisible at 40%. The donut encodes share as angle, so "one country is
 * most of my traffic" reads instantly, which is the actual question.
 *
 * recharts, matching the live billing charts. Deliberately not the chart.js `Doughnut`
 * in `components/overview/OverviewHeroChart.tsx`: that file is in the dead, pre-theme
 * cluster, and pulling a second chart library into a live path when recharts is already
 * here would make the existing three-library situation worse.
 *
 * Colors are `--primary` at the same opacity steps the map uses, so a country's slice
 * and its landmass are visibly the same thing.
 */

import React from "react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { useI18n } from "@/components/i18n-provider";
import { formatCount } from "./format";
import { CHART_TOOLTIP_STYLE } from "@/lib/chart-theme";
import type { GeoVars } from "./VisitorMap";
import "./monitoring.css";

export interface DonutSlice {
  code: string;
  count: number;
  /**
   * The same CSS custom properties the map's paths carry. Passed through rather than
   * resolved here so a slice and its landmass cannot end up different colours.
   */
  vars: GeoVars;
  /** Whether the flag yielded a usable hue — the `data-hue` selector hook. */
  hasHue: boolean;
}

interface Props {
  slices: DonutSlice[];
  total: number;
  nameOf: (code: string) => string;
  /**
   * The country the user has clicked, or null.
   *
   * Needed here, even though the dimming itself is pure CSS: the wrapper's
   * `[data-geo-selected]` matches every descendant `.geo-country`, and the donut's cells
   * ARE `.geo-country`. Without this the donut dimmed as a whole — including the slice
   * belonging to the very country being singled out.
   */
  selected?: string | null;
}

export const CountryDonut: React.FC<Props> = ({ slices, total, nameOf, selected = null }) => {
  const { t } = useI18n();
  const m = t.projects.monitoring;

  if (slices.length === 0 || total === 0) return null;

  return (
    <div className="relative">
      <ResponsiveContainer width="100%" height={180}>
        <PieChart>
          <Pie
            data={slices}
            dataKey="count"
            nameKey="code"
            // A donut, not a pie: the hole carries the total, which is the number a
            // reader wants first and would otherwise need a separate line for.
            innerRadius="58%"
            outerRadius="88%"
            paddingAngle={1}
            stroke="var(--color-card)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {slices.map((s) => (
              // Same CSS as the map, so a slice and its landmass are always the same
              // colour — otherwise the donut stops being a key.
              <Cell
                key={s.code}
                className="geo-country"
                data-lit=""
                data-selected={selected === s.code ? "" : undefined}
                data-hue={s.hasHue ? "" : undefined}
                style={s.vars as React.CSSProperties}
              />
            ))}
          </Pie>
          <Tooltip
            contentStyle={CHART_TOOLTIP_STYLE}
            formatter={(value: unknown, name: unknown) => [
              formatCount(Number(value)),
              nameOf(String(name)),
            ]}
          />
        </PieChart>
      </ResponsiveContainer>

      {/* Centred in the hole. `pointer-events-none` so it can't swallow the slices'
          hover targets underneath. */}
      {/* z-0 so the tooltip (z-40) paints over it. Previously this absolute overlay
          covered the tooltip whenever a slice near the centre was hovered. */}
      <div className="pointer-events-none absolute inset-0 z-0 flex flex-col items-center justify-center">
        <span className="text-xl font-semibold tabular-nums text-foreground">
          {formatCount(total)}
        </span>
        <span className="text-[11px] text-muted-foreground">{m.requests}</span>
      </div>
    </div>
  );
};
