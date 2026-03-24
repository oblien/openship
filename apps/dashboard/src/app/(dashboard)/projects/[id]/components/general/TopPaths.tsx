"use client";
import React, { useState } from "react";
import { generateIcon } from "@/utils/icons";

interface PathData {
  path: string;
  count: number;
  percentage: string;
}

interface Props {
  paths: PathData[];
}

export const TopPaths: React.FC<Props> = ({ paths }) => {
  const [showAll, setShowAll] = useState(false);
  
  const displayedPaths = showAll ? paths : paths.slice(0, 5);
  const hasMorePaths = paths.length > 5;

  return (
    <div className="bg-card rounded-2xl border border-border/50 p-5">
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-2">
          {generateIcon('trend%20up-79-1681196106.png', 24, 'hsl(var(--primary))')}
          <h3 className="text-base font-semibold text-foreground">Top Paths</h3>
        </div>
        {hasMorePaths && (
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-xs font-medium text-primary hover:text-primary/80 transition-colors"
          >
            {showAll ? 'Show Less' : `+${paths.length - 5}`}
          </button>
        )}
      </div>
      <div className="space-y-4">
        {displayedPaths.map((path, idx) => (
          <div key={idx}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground font-medium truncate pr-2">{path.path}</span>
              <span className="text-xs font-medium text-primary">{path.percentage}%</span>
            </div>
            <div className="w-full bg-muted/60 rounded-full h-2 overflow-hidden">
              <div 
                className="h-full bg-primary rounded-full transition-all"
                style={{ width: `${path.percentage}%` }}
              ></div>
            </div>
            <p className="text-xs text-muted-foreground/70 mt-1">{path.count} requests</p>
          </div>
        ))}
      </div>
    </div>
  );
};
