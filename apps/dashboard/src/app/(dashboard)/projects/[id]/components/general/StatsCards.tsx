import React from "react";

interface Props {
  stats: Array<{
    label: string;
    value: string;
    icon: React.ReactNode;
    subtext?: string;
  }>;
}

export const StatsCards: React.FC<Props> = ({ stats }) => {
  return (
    <div className="grid grid-cols-2 gap-4">
      {stats.map((stat) => {
        return (
          <div key={stat.label} className="bg-card border border-border/50 rounded-2xl p-4 transition-colors">
            <div className="flex flex-col">
              <div className="mb-3 flex items-center gap-2">
                <div className="text-primary">
                  {stat.icon}
                </div>
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
