"use client";
import React, { useState } from "react";
import { BarChart3, TrendingUp } from "lucide-react";
import { generateIcon } from "@/utils/icons";
import { SlidingToggle } from "@/components/ui/SlidingToggle";

interface TrafficData {
  hour: number;
  requests: number;
}

interface Props {
  trafficData: TrafficData[];
  isLoading: boolean;
  dateRange?: string;
  totalRequests?: number;
}

export const TrafficChart: React.FC<Props> = ({
  trafficData,
  isLoading,
  dateRange,
  totalRequests,
}) => {
  const [chartType, setChartType] = useState<'bar' | 'area'>('area');
  const hasAnalytics = typeof totalRequests === "number";
  const maxRequests = Math.max(...trafficData.map(d => d.requests), 1);
  if(trafficData.length === 0) {
    trafficData = Array.from({ length: 24 }, (_, i) => ({
      hour: i,
      requests: 0,
    }));
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-4 sm:p-6 h-[320px] sm:h-[380px] flex flex-col">
      <div className="flex items-center justify-between gap-2 sm:gap-0 mb-4 sm:mb-5">
        <div className="flex items-center gap-2 sm:gap-3 flex-1 min-w-0">
          {generateIcon('chart%204%20line-5-1666004410.png', 24, 'hsl(var(--primary))')}
          <div className="min-w-0">
            <h3 className="text-sm sm:text-lg font-semibold text-foreground truncate">Traffic Overview</h3>
            <p className="text-[10px] sm:text-sm text-muted-foreground/70 truncate">{dateRange || 'Last 24 hours'}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Chart Type Selector */}
          <SlidingToggle
            options={[
              {
                value: 'bar',
                icon: <BarChart3 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />,
                label: 'Bar',
              },
              {
                value: 'area',
                icon: <TrendingUp className="w-3.5 h-3.5 sm:w-4 sm:h-4" />,
                label: 'Area',
              },
            ]}
            value={chartType}
            onChange={(value) => setChartType(value as 'bar' | 'area')}
            variant="rounded"
            selectedBg="bg-primary"
            selectedTextColor="text-primary-foreground"
            unselectedTextColor="text-muted-foreground"
            backgroundColor="bg-card"
            size="sm"
          />
         
        </div>
      </div>

      {/* Traffic Chart */}
      {isLoading ? (
        <div className="flex items-center justify-center flex-1">
          <div className="text-sm text-muted-foreground/70">Loading analytics...</div>
        </div>
      ) : !hasAnalytics ? (
        <div className="flex flex-1 items-center justify-center rounded-2xl border border-dashed border-border/70 bg-muted/20">
          <div className="text-center">
            <p className="text-sm font-medium text-foreground">No traffic data yet</p>
            <p className="mt-1 text-sm text-muted-foreground">This chart will populate after the app receives requests.</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col">
          <div className="relative flex-1">
            <svg className="absolute inset-0 w-full h-full" viewBox="0 0 1000 200" preserveAspectRatio="none">
              <defs>
                <linearGradient id="trafficGradient" x1="0%" y1="0%" x2="0%" y2="100%">
                  <stop offset={`${chartType == 'bar' ? 100 : 20}%`} stopColor="hsl(var(--primary))" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0.05" />
                </linearGradient>
              </defs>

              {chartType === 'bar' && (
                /* Bar Chart */
                <>
                  {trafficData.map((d, i) => {
                    const containerWidth = 1000;
                    const containerHeight = 200;
                    const barWidth = containerWidth / trafficData.length * 0.7;
                    const gap = containerWidth / trafficData.length * 0.15;
                    const x = (i / trafficData.length) * containerWidth + gap;
                    const height = (d.requests / maxRequests) * 180;
                    const y = containerHeight - height;

                    return (
                      <rect
                        key={i}
                        x={x}
                        y={y}
                        width={barWidth}
                        height={height}
                        fill="url(#trafficGradient)"
                        rx="4"
                        ry="4"
                      />
                    );
                  })}
                </>
              )}

              {chartType === 'area' && (
                /* Area Chart with Border Line */
                <>
                  {/* Area Fill */}
                  <path
                    d={`M 0 200 ${trafficData.map((d, i) => {
                      const x = (i / (trafficData.length - 1)) * 1000;
                      const y = 200 - (d.requests / maxRequests) * 180;
                      return `L ${x} ${y}`;
                    }).join(' ')} L 1000 200 Z`}
                    fill="url(#trafficGradient)"
                  />
                  {/* Top Border Line */}
                  <path
                    d={trafficData.map((d, i) => {
                      const x = (i / (trafficData.length - 1)) * 1000;
                      const y = 200 - (d.requests / maxRequests) * 180;
                      return `${i === 0 ? 'M' : 'L'} ${x} ${y}`;
                    }).join(' ')}
                    fill="none"
                    stroke="hsl(var(--primary))"
                    strokeWidth="2"
                  />
                </>
              )}
            </svg>
          </div>

          {/* Hour Labels */}
          <div className="flex items-center justify-between mt-2 text-[9px] sm:text-[10px] text-muted-foreground">
            {trafficData.filter((_, i) => i % 4 === 0).map((d, i) => (
              <span key={i}>{d.hour}:00</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
