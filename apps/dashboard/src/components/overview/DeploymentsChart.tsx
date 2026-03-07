'use client';

import React, { useState } from 'react';
import { TrendingUp, BarChart3 } from 'lucide-react';
import { SlidingToggle } from '@/components/ui/SlidingToggle';
import { DeploymentData, ChartType, TimePeriod } from './types';

interface DeploymentsChartProps {
  data: DeploymentData;
  isLoading?: boolean;
  period?: TimePeriod;
  onPeriodChange?: (period: TimePeriod) => void;
}

const DeploymentsChart: React.FC<DeploymentsChartProps> = ({
  data,
  isLoading = false,
  period = 7,
  onPeriodChange,
}) => {
  const [chartType, setChartType] = useState<ChartType>('area');

  if (isLoading) {
    return (
      <div className="bg-white rounded-[20px] border border-black/5 p-6 h-[280px]">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 bg-black/5 rounded-xl animate-pulse" />
          <div className="space-y-2">
            <div className="h-5 w-32 bg-black/5 rounded animate-pulse" />
            <div className="h-4 w-20 bg-black/5 rounded animate-pulse" />
          </div>
        </div>
        <div className="h-36 bg-black/5 rounded-xl animate-pulse" />
      </div>
    );
  }

  const hasData = data.daily.length > 0 && data.daily.some(d => d.value > 0);
  const maxValue = Math.max(...data.daily.map(d => d.value), 1);

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  };

  const renderAreaChart = () => {
    if (data.daily.length === 0) return null;

    const points = data.daily.map((day, index) => {
      const height = hasData && maxValue > 0 ? (day.value / maxValue) * 85 : 0;
      const x = data.daily.length > 1 ? (index / (data.daily.length - 1)) * 100 : 50;
      const y = hasData ? (95 - height) : 92;
      return `${x},${y}`;
    }).join(' ');

    return (
      <svg className="w-full h-36" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="deployGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#0d9488" stopOpacity={hasData ? "0.15" : "0.03"} />
            <stop offset="100%" stopColor="#0d9488" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon
          points={`0,100 ${points} 100,100`}
          fill="url(#deployGradient)"
        />
        <polyline
          points={points}
          fill="none"
          stroke="#0d9488"
          strokeOpacity={hasData ? "1" : "0.2"}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  };

  const renderBarChart = () => {
    return (
      <div className="flex items-end justify-between gap-2 h-36">
        {data.daily.map((day, index) => {
          const height = hasData && maxValue > 0 ? (day.value / maxValue) * 100 : 0;
          const isToday = index === data.daily.length - 1;
          const minHeight = hasData ? (height > 5 ? height : (height > 0 ? 8 : 3)) : 3;
          
          return (
            <div key={index} className="flex-1 flex flex-col items-center group">
              <div className="w-full relative h-36 flex items-end">
                {day.value > 0 && (
                  <div className="absolute -top-8 left-1/2 transform -translate-x-1/2 bg-teal-600 text-white text-xs px-2.5 py-1.5 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap z-10">
                    {day.value} deployment{day.value !== 1 ? 's' : ''}
                  </div>
                )}
                
                <div
                  className={`w-full rounded-t-lg transition-all duration-300 ${
                    isToday
                      ? 'bg-teal-600'
                      : day.value > 0
                      ? 'bg-teal-400 group-hover:bg-teal-500'
                      : 'bg-teal-100'
                  }`}
                  style={{ height: `${minHeight}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const periodOptions: { value: TimePeriod; label: string }[] = [
    { value: 7, label: '7d' },
    { value: 14, label: '14d' },
    { value: 30, label: '30d' },
  ];

  return (
    <div className="bg-white rounded-[20px] border border-black/5 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-black/5">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-black">Deployments</h3>
            <div className="flex items-baseline gap-2 mt-0.5">
              <p className="text-xl font-bold text-teal-600">{data.total}</p>
              <span className="text-xs text-black/40">last {period} days</span>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            {onPeriodChange && (
              <div className="flex items-center gap-1 bg-black/[0.03] rounded-full p-1">
                {periodOptions.map((option) => (
                  <button
                    key={option.value}
                    onClick={() => onPeriodChange(option.value)}
                    className={`px-3 py-1.5 text-xs font-medium rounded-full transition-all ${
                      period === option.value
                        ? 'bg-white text-black shadow-sm'
                        : 'text-black/50 hover:text-black'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            )}
            
            <SlidingToggle
              options={[
                { value: 'bar', icon: <BarChart3 className="w-4 h-4" /> },
                { value: 'area', icon: <TrendingUp className="w-4 h-4" /> },
              ]}
              value={chartType}
              onChange={(value) => setChartType(value as ChartType)}
              variant="rounded"
              selectedBg="bg-teal-600"
              selectedTextColor="text-white"
              unselectedTextColor="text-black/50"
              backgroundColor="bg-black/[0.03]"
              size="sm"
            />
          </div>
        </div>
      </div>

      {/* Chart */}
      <div className="px-6 py-5">
        <div className="mb-3">
          {chartType === 'area' ? renderAreaChart() : renderBarChart()}
        </div>

        {/* Labels */}
        <div className="flex items-center justify-between gap-2 mt-3">
          {data.daily.map((day, index) => {
            const isToday = index === data.daily.length - 1;
            return (
              <div key={index} className="flex-1 text-center">
                <span className={`text-xs font-medium ${isToday ? 'text-teal-600' : 'text-black/40'}`}>
                  {formatDate(day.date)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default DeploymentsChart;
