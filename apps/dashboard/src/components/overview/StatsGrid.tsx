'use client';

import React from 'react';
import { 
  Coins, 
  Rocket, 
  Cpu, 
  Box, 
  Activity,
  Bot,
  TrendingUp,
  TrendingDown
} from 'lucide-react';
import { OverviewStats } from './types';

interface StatsGridProps {
  stats: OverviewStats;
  isLoading?: boolean;
}

interface StatCardProps {
  title: string;
  value: string | number;
  subtitle?: string;
  icon: React.ReactNode;
  trend?: number;
  color: string;
  bgColor: string;
}

const StatCard: React.FC<StatCardProps> = ({
  title,
  value,
  subtitle,
  icon,
  trend,
  color,
  bgColor,
}) => {
  return (
    <div className="bg-white rounded-[20px] border border-black/5 p-5 hover:shadow-lg hover:border-black/10 transition-all duration-300 group">
      <div className="flex items-start justify-between mb-4">
        <div 
          className="w-11 h-11 rounded-xl flex items-center justify-center transition-transform group-hover:scale-105"
          style={{ backgroundColor: bgColor }}
        >
          <div style={{ color }}>{icon}</div>
        </div>
        
        {trend !== undefined && trend !== 0 && (
          <div className={`flex items-center gap-1 text-xs font-medium px-2 py-1 rounded-full ${
            trend > 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-600'
          }`}>
            {trend > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            <span>{Math.abs(trend)}%</span>
          </div>
        )}
      </div>
      
      <div>
        <p className="text-2xl font-bold text-black mb-1">{value}</p>
        <p className="text-sm text-black/50">{title}</p>
        {subtitle && (
          <p className="text-xs text-black/40 mt-1">{subtitle}</p>
        )}
      </div>
    </div>
  );
};

const StatCardSkeleton: React.FC = () => (
  <div className="bg-white rounded-[20px] border border-black/5 p-5">
    <div className="flex items-start justify-between mb-4">
      <div className="w-11 h-11 rounded-xl bg-black/5 animate-pulse" />
    </div>
    <div className="space-y-2">
      <div className="h-7 w-20 bg-black/5 rounded animate-pulse" />
      <div className="h-4 w-28 bg-black/5 rounded animate-pulse" />
    </div>
  </div>
);

const StatsGrid: React.FC<StatsGridProps> = ({ stats, isLoading = false }) => {
  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString();
  };

  const formatCredits = (value: string | number): string => {
    // If already formatted string (with K/M), just add $
    if (typeof value === 'string') {
      return `$${value}`;
    }
    // If number, format with 2 decimals
    return `$${value.toFixed(2)}`;
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
        {Array(6).fill(0).map((_, i) => <StatCardSkeleton key={i} />)}
      </div>
    );
  }

  const statCards = [
    {
      title: 'Credits Balance',
      value: formatCredits(stats.creditsBalance),
      icon: <Coins className="w-5 h-5" />,
      color: '#059669',
      bgColor: 'rgba(5, 150, 105, 0.1)',
    },
    {
      title: 'Token Usage',
      value: formatNumber(stats.totalTokenUsage),
      subtitle: 'This month',
      icon: <Activity className="w-5 h-5" />,
      color: '#8b5cf6',
      bgColor: 'rgba(139, 92, 246, 0.1)',
    },
    {
      title: 'API Requests',
      value: formatNumber(stats.totalApiRequests),
      subtitle: 'Last 7 days',
      icon: <Cpu className="w-5 h-5" />,
      color: '#3b82f6',
      bgColor: 'rgba(59, 130, 246, 0.1)',
    },
    {
      title: 'Deployments',
      value: stats.totalDeployments,
      subtitle: `${stats.successfulDeployments} successful`,
      icon: <Rocket className="w-5 h-5" />,
      color: '#f59e0b',
      bgColor: 'rgba(245, 158, 11, 0.1)',
    },
    {
      title: 'Active Projects',
      value: stats.activeProjects,
      icon: <Box className="w-5 h-5" />,
      color: '#ec4899',
      bgColor: 'rgba(236, 72, 153, 0.1)',
    },
    {
      title: 'Sandboxes',
      value: stats.totalSandboxes,
      subtitle: `${stats.activeSandboxes} active`,
      icon: <Bot className="w-5 h-5" />,
      color: '#06b6d4',
      bgColor: 'rgba(6, 182, 212, 0.1)',
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
      {statCards.map((stat, index) => (
        <StatCard key={index} {...stat} />
      ))}
    </div>
  );
};

export default StatsGrid;

