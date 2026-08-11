'use client';

import React from 'react';
import Link from 'next/link';
import { Plus, GitBranch, Zap, Globe, Eye, RotateCcw } from 'lucide-react';
import { useI18n } from '@/components/i18n-provider';
import { ProjectIllustration } from '@/components/overview/ProjectIllustration';

const EmptyState: React.FC = () => {
  const { t } = useI18n();
  const emptyState = t.dashboard.pages.projects.emptyState;

  return (
    <div className="py-16 text-center">
      <ProjectIllustration className="relative mx-auto mb-8 h-44 w-64" />

      <h3 className="text-2xl font-medium text-foreground/80 mb-2" style={{ letterSpacing: "-0.2px" }}>
        {emptyState.title}
      </h3>
      <p className="text-sm text-muted-foreground max-w-sm mx-auto mb-8 leading-relaxed">
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
          href="/library"
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
          <div className="bg-card border border-border/50 rounded-xl p-4 text-start">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
              <Zap className="size-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">{emptyState.instant}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{emptyState.instantDesc}</p>
          </div>
          <div className="bg-card border border-border/50 rounded-xl p-4 text-start">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
              <Globe className="size-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">{emptyState.global}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{emptyState.globalDesc}</p>
          </div>
          <div className="bg-card border border-border/50 rounded-xl p-4 text-start">
            <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
              <Eye className="size-4 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium text-foreground">{emptyState.previews}</p>
            <p className="text-xs text-muted-foreground mt-0.5">{emptyState.previewsDesc}</p>
          </div>
          <div className="bg-card border border-border/50 rounded-xl p-4 text-start">
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
