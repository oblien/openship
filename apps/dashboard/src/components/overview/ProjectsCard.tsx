'use client';

import React from 'react';
import Link from 'next/link';
import { FolderKanban, ArrowUpRight, CheckCircle2, Loader2, XCircle, Pause } from 'lucide-react';
import { generateIcon } from '@/utils/icons';
import { ProjectData } from './types';

interface ProjectsCardProps {
  data: ProjectData;
  isLoading?: boolean;
}

const ProjectsCard: React.FC<ProjectsCardProps> = ({ data, isLoading = false }) => {
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
        return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />;
      case 'building':
        return <Loader2 className="w-3.5 h-3.5 text-blue-500 animate-spin" />;
      case 'failed':
        return <XCircle className="w-3.5 h-3.5 text-rose-500" />;
      case 'paused':
        return <Pause className="w-3.5 h-3.5 text-amber-500" />;
    }
  };

  const getStatusBadge = (status: 'live' | 'building' | 'failed' | 'paused') => {
    const styles = {
      live: 'bg-emerald-50 text-emerald-700 border-emerald-100',
      building: 'bg-blue-50 text-blue-700 border-blue-100',
      failed: 'bg-rose-50 text-rose-700 border-rose-100',
      paused: 'bg-amber-50 text-amber-700 border-amber-100',
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

  const getFrameworkIcon = (framework: string) => {
    const iconMap: Record<string, string> = {
      'Next.js': 'nextjs-91-1662289277.png',
      'React': 'react-51-1662290199.png',
      'Vue.js': 'vuejs-31-1662290199.png',
      'Nuxt.js': 'nuxtjs-11-1662289277.png',
      'Astro': 'astro-31-1662289277.png',
    };
    return generateIcon(iconMap[framework] || 'code-45-1658433844.png', 16, 'rgba(0,0,0,0.6)');
  };

  return (
    <div className="bg-gradient-to-br from-pink-50/80 to-white rounded-[20px] border border-pink-100 p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-pink-100 rounded-xl flex items-center justify-center">
            <FolderKanban className="w-5 h-5 text-pink-600" />
          </div>
          <div>
            <h3 className="font-semibold text-black">Projects</h3>
            <p className="text-xs text-black/40">Active deployments</p>
          </div>
        </div>
        
        <Link 
          href="/projects"
          className="p-2 hover:bg-pink-100 rounded-lg transition-colors group"
        >
          <ArrowUpRight className="w-4 h-4 text-pink-600 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
        </Link>
      </div>

      {/* Stats row */}
      <div className="flex items-center gap-3 mb-4 pb-4 border-b border-pink-100">
        <div className="flex-1 text-center">
          <p className="text-2xl font-bold text-pink-600">{data.total}</p>
          <p className="text-xs text-black/40">Total</p>
        </div>
        <div className="w-px h-8 bg-pink-100" />
        <div className="flex-1 text-center">
          <p className="text-2xl font-bold text-emerald-600">{data.live}</p>
          <p className="text-xs text-black/40">Live</p>
        </div>
        <div className="w-px h-8 bg-pink-100" />
        <div className="flex-1 text-center">
          <p className="text-2xl font-bold text-blue-600">{data.building}</p>
          <p className="text-xs text-black/40">Building</p>
        </div>
      </div>

      {/* Footer */}
      {data.failed > 0 && (
        <div className="pt-4 mt-auto border-t border-pink-100">
          <div className="flex items-center gap-2 text-rose-600 bg-rose-50 px-3 py-2 rounded-lg">
            <XCircle className="w-4 h-4" />
            <span className="text-xs font-medium">{data.failed} project{data.failed > 1 ? 's' : ''} need attention</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectsCard;

