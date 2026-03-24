import React from "react";
import { generateIcon } from "@/utils/icons";

interface Props {
  stats: any[];
}

export const StatsCards: React.FC<Props> = ({ stats }) => {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((stat) => {
        return (
          <div key={stat.label} className="bg-card border border-border/50 rounded-2xl hover:shadow-md transition-all p-4">
            <div className="flex flex-col">
              <div className="flex items-center gap-2 mb-3">
                {generateIcon(stat.icon, 24, 'hsl(var(--primary))')}
                <p className="text-xs font-medium text-muted-foreground">{stat.label}</p>
              </div>
              <p className="text-2xl font-semibold text-foreground mb-1">
                {stat.value}
              </p>
              {stat.subtext && (
                <p className="text-xs text-muted-foreground/70 font-normal">
                  {stat.subtext}
                </p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
