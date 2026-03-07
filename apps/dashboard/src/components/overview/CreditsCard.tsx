'use client';

import React from 'react';
import Link from 'next/link';
import { Coins, ArrowUpRight, TrendingUp, TrendingDown, Plus } from 'lucide-react';
import { CreditData, DailyMetric } from './types';

interface CreditsCardProps {
  data: CreditData;
  isLoading?: boolean;
}

const CreditsCard: React.FC<CreditsCardProps> = ({ data, isLoading = false }) => {
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

  const formatCredits = (value: string | number): string => {
    // If already formatted string (with K/M), return as is
    if (typeof value === 'string') {
      return value;
    }
    // If number, format with 2 decimals
    return value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };

  // Mini sparkline chart
  const renderSparkline = (dailyData: DailyMetric[]) => {
    if (!dailyData || dailyData.length === 0) return null;
    
    const maxValue = Math.max(...dailyData.map(d => d.value), 1);
    const points = dailyData.map((day, index) => {
      const height = maxValue > 0 ? (day.value / maxValue) * 100 : 0;
      const x = dailyData.length > 1 ? (index / (dailyData.length - 1)) * 100 : 50;
      const y = 100 - (height || 0);
      return `${x},${y}`;
    }).join(' ');

    return (
      <svg className="w-full h-12" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="creditSparkline" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="rgb(5, 150, 105)" stopOpacity="0.2" />
            <stop offset="100%" stopColor="rgb(5, 150, 105)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon
          points={`0,100 ${points} 100,100`}
          fill="url(#creditSparkline)"
        />
        <polyline
          points={points}
          fill="none"
          stroke="rgb(5, 150, 105)"
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  };

  return (
    <div className="bg-gradient-to-br from-emerald-50/80 to-white rounded-[20px] border border-emerald-100 p-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center">
            <Coins className="w-5 h-5 text-emerald-600" />
          </div>
          <div>
            <h3 className="font-semibold text-black">Credits Balance</h3>
            <p className="text-xs text-black/40">Available to use</p>
          </div>
        </div>
        
        <Link 
          href="/billing"
          className="p-2 hover:bg-emerald-100 rounded-lg transition-colors group"
        >
          <ArrowUpRight className="w-4 h-4 text-emerald-600 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
        </Link>
      </div>

      {/* Balance */}
      <div className="mb-4">
        <div className="flex items-baseline gap-2">
          <span className="text-3xl font-bold text-emerald-600">
            ${formatCredits(data.balance)}
          </span>
          {data.trend !== 0 && (
            <span className={`flex items-center gap-0.5 text-xs font-medium ${
              data.trend > 0 ? 'text-emerald-600' : 'text-rose-600'
            }`}>
              {data.trend > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
              {Math.abs(data.trend)}%
            </span>
          )}
        </div>
      </div>

      {/* Sparkline */}
      <div className="flex-1 mb-4">
        {renderSparkline(data.daily)}
      </div>

      {/* Spent this period */}
      <div className="flex items-center justify-between pt-4 border-t border-emerald-100">
        <div>
          <p className="text-xs text-black/40 mb-0.5">Spent this month</p>
          <p className="text-sm font-semibold text-black">${formatCredits(data.spent)}</p>
        </div>
        
        <Link
          href="/billing"
          className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 text-white text-xs font-medium rounded-full hover:bg-emerald-700 transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Add
        </Link>
      </div>
    </div>
  );
};

export default CreditsCard;

