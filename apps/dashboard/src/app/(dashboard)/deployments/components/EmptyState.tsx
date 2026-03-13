"use client";

import React from "react";
import Link from "next/link";
import { SearchX, Plus, GitBranch } from "lucide-react";

interface EmptyStateProps {
  hasFilters: boolean;
}

export const EmptyState: React.FC<EmptyStateProps> = ({ hasFilters }) => {
  if (hasFilters) {
    return (
      <div className="bg-card rounded-2xl border border-border/50 p-16 text-center">
        <div className="max-w-md mx-auto">
          <div className="w-16 h-16 bg-muted/60 rounded-full flex items-center justify-center mx-auto mb-4 border border-border/50">
            <SearchX className="w-7 h-7 text-muted-foreground/50" />
          </div>
          <h3 className="text-lg font-medium text-foreground/80 mb-2">No deployments found</h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            Try adjusting your filters or clearing your search.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-2xl border border-border/50 px-6 pb-10 text-center">
      {/* SVG Illustration — matches home page empty state */}
      <div className="relative mx-auto w-64 h-44">
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 260 180" fill="none">
          {/* Background card stack */}
          <rect x="75" y="45" width="130" height="95" rx="14" fill="var(--th-sf-04)" />
          <rect x="65" y="35" width="130" height="95" rx="14" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
          <rect x="55" y="25" width="130" height="95" rx="14" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />

          {/* Card header bar */}
          <rect x="55" y="25" width="130" height="28" rx="14" fill="var(--th-sf-05)" />
          <circle cx="72" cy="39" r="4" fill="#ef4444" fillOpacity="0.6" />
          <circle cx="84" cy="39" r="4" fill="#eab308" fillOpacity="0.6" />
          <circle cx="96" cy="39" r="4" fill="#22c55e" fillOpacity="0.6" />

          {/* Content lines */}
          <rect x="70" y="65" width="50" height="5" rx="2.5" fill="var(--th-on-12)" />
          <rect x="70" y="76" width="85" height="4" rx="2" fill="var(--th-on-08)" />
          <rect x="70" y="85" width="65" height="4" rx="2" fill="var(--th-on-08)" />

          {/* Rocket icon in card */}
          <circle cx="84" cy="108" r="10" fill="var(--th-on-05)" stroke="var(--th-on-10)" strokeWidth="1" />
          <path d="M84 102l3 8h-6l3-8z" fill="var(--th-on-20)" />
          <circle cx="84" cy="106" r="2" fill="var(--th-on-30)" />

          {/* Plus button */}
          <circle cx="210" cy="90" r="22" fill="var(--th-on-05)" />
          <circle cx="210" cy="90" r="16" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
          <path d="M210 82v16M202 90h16" stroke="var(--th-on-40)" strokeWidth="2" strokeLinecap="round" />

          {/* Decorative dots */}
          <circle cx="30" cy="60" r="4" fill="var(--th-on-10)" />
          <circle cx="40" cy="140" r="6" fill="var(--th-on-08)" />
          <circle cx="230" cy="40" r="3" fill="var(--th-on-12)" />
          <circle cx="245" cy="130" r="5" fill="var(--th-on-06)" />

          {/* Sparkle accents */}
          <path d="M25 100l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
          <path d="M220 150l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />

          {/* Connecting line */}
          <path d="M185 95 Q 192 92 195 90" stroke="var(--th-on-12)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />
        </svg>
      </div>

      <h3 className="text-lg font-medium text-foreground/80 mb-2">
        No deployments yet
      </h3>
      <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-8 leading-relaxed">
        Deploy your first project and it will appear here with
        build status, commit details, and performance metrics.
      </p>

      <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
        <Link
          href="/library"
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
        >
          <Plus className="size-4" />
          Deploy Project
        </Link>
        <Link
          href="/library"
          className="inline-flex items-center gap-2 px-6 py-3 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
        >
          <GitBranch className="size-4" />
          Browse Templates
        </Link>
      </div>
    </div>
  );
};

