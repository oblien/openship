'use client';

import { Icon as UiIcon } from "@repo/ui/icons";

import React from 'react';
import Link from 'next/link';

import { ProjectData } from './types';
import { useI18n, interpolate } from '@/components/i18n-provider';

interface ProjectsCardProps {
  data: ProjectData;
  isLoading?: boolean;
}

const ProjectsCard: React.FC<ProjectsCardProps> = ({ data, isLoading = false }) => {
  const { t } = useI18n();
  if (isLoading) {
    return (
      <div className="bg-white rounded-[20px] border border-black/5 p-6 h-full">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 bg-black/5 rounded-xl animate-pulse" />
          <div className="space-y-2">
            <div className="h-5 w-24 bg-black/5 rounded animate-pulse" />
            <div className="h-4 w-16 bg-black/5 rounded animate-pulse" />
          </div>
        </div>
        <div className="space-y-3">
          {[1, 2, 3].map(i => (
            <div key={i} className="h-12 bg-black/5 rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const getStatusIcon = (status: 'live' | 'building' | 'failed' | 'paused') => {
    switch (status) {
      case 'live':
        return <UiIcon name="check-circle" className="w-3.5 h-3.5 text-success" />;
      case 'building':
        return <UiIcon name="spinner" className="w-3.5 h-3.5 text-info animate-spin" />;
      case 'failed':
        return <UiIcon name="x-circle" className="w-3.5 h-3.5 text-danger" />;
      case 'paused':
        return <UiIcon name="pause" className="w-3.5 h-3.5 text-warning" />;
    }
  };

  const getStatusBadge = (status: 'live' | 'building' | 'failed' | 'paused') => {
    const styles = {
      live: 'bg-success-bg text-success border-success-border',
      building: 'bg-info-bg text-info border-info-border',
      failed: 'bg-danger-bg text-danger border-danger-border',
      paused: 'bg-warning-bg text-warning border-warning-border',
    };
    return styles[status];
  };

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    return 'Just now';
  };



  return (
    <div className="bg-gradient-to-br from-pink-50/80 to-white rounded-[20px] border border-pink-100 p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-pink-100 rounded-xl flex items-center justify-center">
            <UiIcon name="project" className="w-5 h-5 text-pink-600" />
          </div>
          <div>
            <h3 className="font-semibold text-black">{t.overview.projects.title}</h3>
            <p className="text-xs text-black/40">{t.overview.projects.activeDeployments}</p>
          </div>
        </div>
        
        <Link 
          href="/projects"
          className="p-2 hover:bg-pink-100 rounded-lg transition-colors group"
        >
          <UiIcon name="arrow-up-right" className="w-4 h-4 text-pink-600 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
        </Link>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 mb-4 pb-4 border-b border-pink-100">
        <div className="flex-1 text-center">
          <p className="text-2xl font-bold text-pink-600">{data.total}</p>
          <p className="text-xs text-black/40">{t.overview.projects.total}</p>
        </div>
        <div className="w-px h-8 bg-pink-100" />
        <div className="flex-1 text-center">
          <p className="text-2xl font-bold text-success">{data.live}</p>
          <p className="text-xs text-black/40">{t.overview.projects.live}</p>
        </div>
        <div className="w-px h-8 bg-pink-100" />
        <div className="flex-1 text-center">
          <p className="text-2xl font-bold text-info">{data.building}</p>
          <p className="text-xs text-black/40">{t.overview.projects.building}</p>
        </div>
      </div>

      {/* Footer */}
      {data.failed > 0 && (
        <div className="pt-4 mt-auto border-t border-pink-100">
          <div className="flex items-center gap-2 text-danger bg-danger-bg px-3 py-2 rounded-lg">
            <UiIcon name="x-circle" className="w-4 h-4" />
            <span className="text-xs font-medium">{interpolate(
              data.failed === 1
                ? t.overview.projects.needAttentionSingular
                : t.overview.projects.needAttentionPlural,
              { count: String(data.failed) },
            )}</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectsCard;

