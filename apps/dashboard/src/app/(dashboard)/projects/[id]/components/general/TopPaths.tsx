"use client";
import React, { useState } from "react";
import { MoreVertical, EyeOff, TrendingUp } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { formatCount } from "@/components/monitoring/format";
import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";

interface PathData {
  path: string;
  count: number;
  percentage: string;
}

interface Props {
  paths: PathData[];
  /**
   * Turn collection off. Omitted where there is nothing to switch — the Overview tab's
   * copy of this card, and cloud projects, where Oblien's edge aggregates paths regardless.
   */
  onDisable?: () => void;
  /** True while the toggle is in flight. */
  isBusy?: boolean;
}

export const TopPaths: React.FC<Props> = ({ paths, onDisable, isBusy = false }) => {
  const { t } = useI18n();
  const [showAll, setShowAll] = useState(false);
  
  const displayedPaths = showAll ? paths : paths.slice(0, 5);
  const hasMorePaths = paths.length > 5;

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          {/* lucide, not the raster mask via utils/icons: every other component in this
              feature uses lucide, and `utils/icons.js` carries JSX in a .js file, which the
              test transform cannot parse — so importing it pulls any test that renders this
              card down with it. Same glyph either way. */}
          <TrendingUp className="size-5 text-primary" />
          <h3 className="text-base font-semibold text-foreground">{t.projectDetail.general.topPaths.title}</h3>
        </div>
        <div className="flex items-center gap-1">
          {hasMorePaths && (
            <button
              onClick={() => setShowAll(!showAll)}
              className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
            >
              {showAll ? t.projectDetail.general.topPaths.showLess : `+${paths.length - 5}`}
            </button>
          )}
          {/* Turning collection back OFF has to be reachable from the card it affects.
              Putting it in project settings instead would mean the only place that shows
              the cost is not the place that can stop paying it. */}
          {onDisable && (
            <DropdownMenu
              align="right"
              disabled={isBusy}
              triggerClassName="rounded-lg p-1 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
              trigger={<MoreVertical className="size-4" />}
              actions={
                [
                  {
                    id: "disable",
                    label: t.projects.monitoring.pathsOff.disable,
                    icon: <EyeOff className="size-4" />,
                    onClick: onDisable,
                    variant: "danger",
                  },
                ] satisfies MenuAction[]
              }
            />
          )}
        </div>
      </div>
      {/* Three lines per row became two.
          The count used to sit on its own line UNDER the bar, so five paths cost five
          extra text lines plus their margins — roughly 90px of height to carry five
          numbers. It now shares the header line with the share, which had empty space
          across the middle anyway. Count first, then percent: the count is the measurement
          and the percent is derived from it. */}
      <div className="space-y-3">
        {displayedPaths.map((path, idx) => (
          <div key={idx}>
            <div className="flex items-baseline gap-2 mb-1.5">
              <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
                {path.path}
              </span>
              {/* Abbreviated (38.2K, not 38210) — the exact figure is in the title, and at
                  full precision the two numbers plus a long path did not fit on one line
                  in a half-width card. */}
              <span
                className="shrink-0 tabular-nums text-xs text-muted-foreground/70"
                title={`${path.count.toLocaleString()} ${t.projectDetail.general.topPaths.requestsShort}`}
              >
                {formatCount(path.count)}
              </span>
              <span className="w-12 shrink-0 text-right text-xs font-medium tabular-nums text-primary">
                {path.percentage}%
              </span>
            </div>
            <div className="w-full bg-muted/60 rounded-full h-2 overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${path.percentage}%` }}
              ></div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
