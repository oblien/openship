'use client';

import React from 'react';
import Link from 'next/link';
import { Cpu, ArrowUpRight, TrendingUp, TrendingDown } from 'lucide-react';
import { ApiRequestData, DailyMetric } from './types';

interface ApiRequestsCardProps {
  data: ApiRequestData;
  isLoading?: boolean;
}

const ApiRequestsCard: React.FC<ApiRequestsCardProps> = ({ data, isLoading = false }) => {
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
        <div className="h-20 bg-black/5 rounded-xl animate-pulse" />
      </div>
    );
  }

  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString();
  };

  // Mini bar chart
  const renderMiniChart = (dailyData: DailyMetric[]) => {
    if (!dailyData || dailyData.length === 0) return null;
    
    const maxValue = Math.max(...dailyData.map(d => d.value), 1);
    
    return (
      <div className="flex items-end gap-1 h-16">
        {dailyData.slice(-7).map((day, index) => {
          const height = maxValue > 0 ? (day.value / maxValue) * 100 : 0;
          const isToday = index === dailyData.slice(-7).length - 1;
          
          return (
            <div
              key={index}
              className={`flex-1 rounded-t transition-all ${
                isToday 
                  ? 'bg-blue-500' 
                  : 'bg-blue-200 hover:bg-blue-300'
              }`}
              style={{ height: `${Math.max(height, 4)}%` }}
              title={`${formatNumber(day.value)} requests`}
            />
          );
        })}
      </div>
    );
  };

  return (
    <div className="bg-gradient-to-br from-blue-50/80 to-white rounded-[20px] border border-blue-100 p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
            <Cpu className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h3 className="font-semibold text-black">API Requests</h3>
            <p className="text-xs text-black/40">Last 7 days</p>
          </div>
        </div>
        
        <Link 
          href="/settings"
          className="p-2 hover:bg-blue-100 rounded-lg transition-colors group"
        >
          <ArrowUpRight className="w-4 h-4 text-blue-600 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
        </Link>
      </div>

      {/* Total */}
      <div className="mb-4">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold text-blue-600">{formatNumber(data.total)}</span>
          {data.trend !== 0 && (
            <span className={`flex items-center gap-0.5 text-xs font-medium ${
              data.trend > 0 ? 'text-emerald-600' : 'text-rose-600'
            }`}>
              {data.trend > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {Math.abs(data.trend)}%
            </span>
          )}
        </div>
        <p className="text-xs text-black/40">Total requests</p>
      </div>

      {/* Mini chart */}
      <div className="flex-1 mb-4 mt-6">
        {renderMiniChart(data.daily)}
      </div>
    </div>
  );
};

export default ApiRequestsCard;

