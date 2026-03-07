'use client';

import React from 'react';
import Link from 'next/link';
import { Plus, GitBranch, Zap, Globe, Eye, RotateCcw } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';

const EmptyState: React.FC = () => {
  const { t } = useI18n();
  const emptyState = t.dashboard.pages.projects.emptyState;

  return (
    <div className="py-16 text-center">
      {/* SVG Illustration - using theme variables */}
      <div className="relative mx-auto w-64 h-44 mb-8">
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 260 180" fill="none">
          {/* Background card stack effect */}
          <rect x="75" y="45" width="130" height="95" rx="14" fill="var(--th-sf-04)" />
          <rect x="65" y="35" width="130" height="95" rx="14" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
          <rect x="55" y="25" width="130" height="95" rx="14" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
          
          {/* Card content - header bar */}
          <rect x="55" y="25" width="130" height="28" rx="14" fill="var(--th-sf-05)" />
          <circle cx="72" cy="39" r="4" fill="#ef4444" fillOpacity="0.6" />
          <circle cx="84" cy="39" r="4" fill="#eab308" fillOpacity="0.6" />
          <circle cx="96" cy="39" r="4" fill="#22c55e" fillOpacity="0.6" />
          
          {/* Content placeholder lines */}
          <rect x="70" y="65" width="50" height="5" rx="2.5" fill="var(--th-on-12)" />
          <rect x="70" y="76" width="85" height="4" rx="2" fill="var(--th-on-08)" />
          <rect x="70" y="85" width="65" height="4" rx="2" fill="var(--th-on-08)" />
          
          {/* Folder/Project icon */}
          <rect x="70" y="100" width="28" height="22" rx="5" fill="var(--th-on-05)" stroke="var(--th-on-10)" strokeWidth="1" />
          <path d="M74 105h8l2.5 2.5h9.5v11H74V105z" fill="var(--th-on-10)" />
          
          {/* Plus button */}
          <circle cx="210" cy="90" r="22" fill="var(--th-on-05)" />
          <circle cx="210" cy="90" r="16" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
          <path d="M210 82v16M202 90h16" stroke="var(--th-on-40)" strokeWidth="2" strokeLinecap="round" />
          
          {/* Decorative elements */}
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
      
      <h3 className="text-2xl font-medium text-foreground/80 mb-2" style={{ letterSpacing: "-0.2px" }}>
        {emptyState.title}
      </h3>
      <p className="text-sm text-muted-foreground/70 max-w-sm mx-auto mb-8 leading-relaxed">
        {emptyState.description}
      </p>
      
      <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-10">
        <Link
          href="/library"
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
        >
          <Plus className="size-4" />
          {emptyState.createProject}
        </Link>
        <Link
          href="/library?tab=templates"
          className="inline-flex items-center gap-2 px-6 py-3 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
        >
          <GitBranch className="size-4" />
          {emptyState.browseTemplates}
        </Link>
      </div>

      {/* Feature highlights - Clean minimal cards */}
      <div className="max-w-2xl mx-auto">
        <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-4">
          {emptyState.zeroConfig}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-card border border-border/50 rounded-xl p-4 text-left">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
              <Zap className="size-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">{emptyState.instant}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{emptyState.instantDesc}</p>
          </div>
          <div className="bg-card border border-border/50 rounded-xl p-4 text-left">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
              <Globe className="size-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">{emptyState.global}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{emptyState.globalDesc}</p>
          </div>
          <div className="bg-card border border-border/50 rounded-xl p-4 text-left">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
              <Eye className="size-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">{emptyState.previews}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{emptyState.previewsDesc}</p>
          </div>
          <div className="bg-card border border-border/50 rounded-xl p-4 text-left">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
              <RotateCcw className="size-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">{emptyState.rollbacks}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{emptyState.rollbacksDesc}</p>
          </div>
        </div>
      </div>

      <p className="text-xs text-muted-foreground/60 mt-8">
        {emptyState.commandPalette.replace('{key}', '')}
        <kbd className="px-1.5 py-0.5 bg-muted rounded text-[10px] font-mono">⌘ K</kbd>
      </p>
    </div>
  );
};

export default EmptyState;
