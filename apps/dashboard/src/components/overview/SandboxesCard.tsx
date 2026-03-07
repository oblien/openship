'use client';

import React from 'react';
import Link from 'next/link';
import { Box, ArrowUpRight, Play, Square, AlertCircle } from 'lucide-react';
import { SandboxData } from './types';

interface SandboxesCardProps {
  data: SandboxData;
  isLoading?: boolean;
}

const SandboxesCard: React.FC<SandboxesCardProps> = ({ data, isLoading = false }) => {
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
            <div key={i} className="h-10 bg-black/5 rounded-xl animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const getStatusIcon = (status: 'running' | 'stopped' | 'error') => {
    switch (status) {
      case 'running':
        return <Play className="w-3 h-3 text-emerald-500 fill-emerald-500" />;
      case 'stopped':
        return <Square className="w-3 h-3 text-gray-400" />;
      case 'error':
        return <AlertCircle className="w-3 h-3 text-rose-500" />;
    }
  };

  const getStatusColor = (status: 'running' | 'stopped' | 'error') => {
    switch (status) {
      case 'running':
        return 'bg-emerald-50 text-emerald-700';
      case 'stopped':
        return 'bg-gray-50 text-gray-600';
      case 'error':
        return 'bg-rose-50 text-rose-700';
    }
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

  const activePercent = data.total > 0 ? Math.round((data.active / data.total) * 100) : 0;

  return (
    <div className="bg-gradient-to-br from-cyan-50/80 to-white rounded-[20px] border border-cyan-100 p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-cyan-100 rounded-xl flex items-center justify-center">
            <Box className="w-5 h-5 text-cyan-600" />
          </div>
          <div>
            <h3 className="font-semibold text-black">Sandboxes</h3>
            <p className="text-xs text-black/40">Development environments</p>
          </div>
        </div>
        
        <Link 
          href="/projects"
          className="p-2 hover:bg-cyan-100 rounded-lg transition-colors group"
        >
          <ArrowUpRight className="w-4 h-4 text-cyan-600 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
        </Link>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 mb-4">
        <div className="flex-1">
          <p className="text-3xl font-bold text-cyan-600">{data.total}</p>
          <p className="text-xs text-black/40">Total sandboxes</p>
        </div>
        
        {/* Active indicator */}
        <div className="flex items-center gap-2">
          <div className="relative w-12 h-12">
            <svg className="w-12 h-12 -rotate-90" viewBox="0 0 36 36">
              <circle
                cx="18"
                cy="18"
                r="15"
                fill="none"
                stroke="rgb(224, 231, 235)"
                strokeWidth="3"
              />
              <circle
                cx="18"
                cy="18"
                r="15"
                fill="none"
                stroke="rgb(6, 182, 212)"
                strokeWidth="3"
                strokeDasharray={`${activePercent} 100`}
                strokeLinecap="round"
              />
            </svg>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-xs font-bold text-cyan-600">{data.active}</span>
            </div>
          </div>
          <div>
            <p className="text-sm font-semibold text-black">{activePercent}%</p>
            <p className="text-xs text-black/40">Active</p>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between pt-4 mt-auto border-t border-cyan-100">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-emerald-500" />
            <span className="text-xs text-black/60">{data.active} running</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-gray-300" />
            <span className="text-xs text-black/60">{data.inactive} stopped</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SandboxesCard;

