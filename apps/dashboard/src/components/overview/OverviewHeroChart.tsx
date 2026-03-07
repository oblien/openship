'use client';

import React from 'react';
import { TrendingUp, TrendingDown, Bot, Activity } from 'lucide-react';
import { Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  ArcElement,
  Tooltip,
  Legend,
} from 'chart.js';
import { DailyMetric, TimePeriod } from './types';

ChartJS.register(ArcElement, Tooltip, Legend);

interface OverviewHeroChartProps {
  tokenData: DailyMetric[];
  requestData: DailyMetric[];
  agentData: DailyMetric[];
  totalTokens: number;
  totalRequests: number;
  totalAgents: number;
  productionAgents: number;
  testingAgents: number;
  tokenTrend: number;
  requestTrend: number;
  agentTrend: number;
  isLoading?: boolean;
  period?: TimePeriod;
  onPeriodChange?: (period: TimePeriod) => void;
}

const OverviewHeroChart: React.FC<OverviewHeroChartProps> = ({
  tokenData,
  requestData,
  totalTokens,
  totalRequests,
  totalAgents,
  productionAgents,
  testingAgents,
  tokenTrend,
  requestTrend,
  agentTrend,
  isLoading = false,
  period = 7,
  onPeriodChange,
}) => {
  const formatNumber = (num: number): string => {
    if (num >= 1000000) return `${(num / 1000000).toFixed(1)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(1)}K`;
    return num.toLocaleString();
  };

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Main Chart Skeleton */}
        <div className="lg:col-span-3 bg-white rounded-[24px] border border-black/5 overflow-hidden">
          {/* Header */}
          <div className="px-6 py-4 border-b border-black/5 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-black/5 rounded-xl animate-pulse" />
              <div className="space-y-2">
                <div className="h-4 w-32 bg-black/5 rounded animate-pulse" />
                <div className="h-3 w-24 bg-black/5 rounded animate-pulse" />
              </div>
            </div>
            <div className="h-8 w-32 bg-black/5 rounded-full animate-pulse" />
          </div>
          {/* Chart Area */}
          <div className="px-6 pt-4 pb-3">
            <div className="h-28 bg-black/5 rounded-xl animate-pulse mb-4" />
          </div>
          {/* Footer */}
          <div className="px-6 py-3.5 bg-white border-t border-black/5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-6">
                <div className="h-4 w-32 bg-black/5 rounded animate-pulse" />
                <div className="h-4 w-32 bg-black/5 rounded animate-pulse" />
              </div>
              <div className="h-3 w-20 bg-black/5 rounded animate-pulse" />
            </div>
          </div>
        </div>
        
        {/* Agents Card Skeleton */}
        <div className="bg-white rounded-[24px] border border-black/5 p-5 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 bg-black/5 rounded-lg animate-pulse" />
              <div className="space-y-1.5">
                <div className="h-3.5 w-16 bg-black/5 rounded animate-pulse" />
                <div className="h-2.5 w-20 bg-black/5 rounded animate-pulse" />
              </div>
            </div>
          </div>
          <div className="flex-1 flex items-center justify-center py-2">
            <div className="w-[110px] h-[110px] rounded-full bg-black/5 animate-pulse" />
          </div>
          <div className="pt-3 border-t border-black/5">
            <div className="flex items-center justify-center gap-5">
              <div className="h-3 w-20 bg-black/5 rounded animate-pulse" />
              <div className="h-3 w-20 bg-black/5 rounded animate-pulse" />
            </div>
          </div>
        </div>
      </div>
    );
  }

  const hasTokenData = tokenData.length > 0 && tokenData.some(d => d.value > 0);
  const hasRequestData = requestData.length > 0 && requestData.some(d => d.value > 0);

  // Main combined area chart
  const renderMainChart = () => {
    const maxTokens = Math.max(...tokenData.map(d => d.value), 1);
    const maxRequests = Math.max(...requestData.map(d => d.value), 1);
    
    const tokenPoints = tokenData.map((day, index) => {
      const height = hasTokenData && maxTokens > 0 ? (day.value / maxTokens) * 75 : 0;
      const x = tokenData.length > 1 ? (index / (tokenData.length - 1)) * 100 : 50;
      const y = hasTokenData ? (92 - height) : 90;
      return `${x},${y}`;
    }).join(' ');

    const requestPoints = requestData.map((day, index) => {
      const height = hasRequestData && maxRequests > 0 ? (day.value / maxRequests) * 60 : 0;
      const x = requestData.length > 1 ? (index / (requestData.length - 1)) * 100 : 50;
      const y = hasRequestData ? (92 - height) : 88;
      return `${x},${y}`;
    }).join(' ');

    return (
      <svg className="w-full h-full" viewBox="0 0 100 100" preserveAspectRatio="none">
        <defs>
          <linearGradient id="tokenAreaGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#8b5cf6" stopOpacity={hasTokenData ? "0.2" : "0.03"} />
            <stop offset="100%" stopColor="#8b5cf6" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="requestAreaGradient" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="#06b6d4" stopOpacity={hasRequestData ? "0.15" : "0.02"} />
            <stop offset="100%" stopColor="#06b6d4" stopOpacity="0" />
          </linearGradient>
        </defs>
        
        {/* Token area - purple */}
        <polygon points={`0,100 ${tokenPoints} 100,100`} fill="url(#tokenAreaGradient)" />
        <polyline 
          points={tokenPoints} 
          fill="none" 
          stroke="#8b5cf6"
          strokeOpacity={hasTokenData ? "1" : "0.2"}
          strokeWidth="2.5" 
          vectorEffect="non-scaling-stroke" 
          strokeLinecap="round" 
          strokeLinejoin="round" 
        />
        
        {/* Request area - cyan */}
        <polygon points={`0,100 ${requestPoints} 100,100`} fill="url(#requestAreaGradient)" />
        <polyline 
          points={requestPoints} 
          fill="none" 
          stroke="#06b6d4"
          strokeOpacity={hasRequestData ? "1" : "0.2"}
          strokeWidth="2" 
          vectorEffect="non-scaling-stroke" 
          strokeLinecap="round" 
          strokeLinejoin="round" 
          strokeDasharray="6 4"
        />
      </svg>
    );
  };

  // Chart.js doughnut for agents
  const doughnutData = {
    labels: ['Production', 'Testing'],
    datasets: [
      {
        data: [productionAgents, testingAgents],
        backgroundColor: ['#06b6d4', '#8b5cf6'],
        hoverBackgroundColor: ['#0891b2', '#7c3aed'],
        borderWidth: 0,
        cutout: '70%',
      },
    ],
  };

  const doughnutOptions = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        backgroundColor: '#1e293b',
        titleFont: { size: 12, weight: 500 as const },
        bodyFont: { size: 11 },
        padding: 10,
        cornerRadius: 8,
        displayColors: true,
        boxWidth: 8,
        boxHeight: 8,
        boxPadding: 4,
      },
    },
  };

  const periodOptions: { value: TimePeriod; label: string }[] = [
    { value: 7, label: '7d' },
    { value: 14, label: '14d' },
    { value: 30, label: '30d' },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
      {/* Main Chart */}
      <div className="lg:col-span-3 bg-white rounded-[24px] border border-black/5 overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-black/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-purple-100 rounded-xl flex items-center justify-center">
                <Activity className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <h3 className="font-semibold text-black">Platform Activity</h3>
                <p className="text-xs text-black/40">Token usage & API requests</p>
              </div>
            </div>
            
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
          </div>
        </div>

        {/* Chart */}
        <div className="px-6 pt-4 pb-3 flex-1">
          <div className="h-28">
            {renderMainChart()}
          </div>
        </div>

        {/* Stats Row */}
        <div className="px-6 py-3.5 bg-white border-t border-black/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-purple-500" />
                <span className="text-xs text-black/50">Tokens</span>
                <span className="text-sm font-semibold text-black">{formatNumber(totalTokens)}</span>
                {tokenTrend !== 0 && (
                  <span className={`flex items-center text-xs font-medium ${tokenTrend > 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                    {tokenTrend > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {Math.abs(tokenTrend)}%
                  </span>
                )}
              </div>
              
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-cyan-500" />
                <span className="text-xs text-black/50">Requests</span>
                <span className="text-sm font-semibold text-black">{formatNumber(totalRequests)}</span>
                {requestTrend !== 0 && (
                  <span className={`flex items-center text-xs font-medium ${requestTrend > 0 ? 'text-emerald-600' : 'text-rose-500'}`}>
                    {requestTrend > 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {Math.abs(requestTrend)}%
                  </span>
                )}
              </div>
            </div>
            
            <span className="text-xs text-black/30">Last {period} days</span>
          </div>
        </div>
      </div>

      {/* Agents Card */}
      <div className="bg-white rounded-[24px] border border-black/5 p-5 flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 bg-cyan-100 rounded-lg flex items-center justify-center">
              <Bot className="w-4 h-4 text-cyan-600" />
            </div>
            <div>
              <h4 className="text-sm font-semibold text-black">Agents</h4>
              <p className="text-[11px] text-black/40">Environments</p>
            </div>
          </div>
          {agentTrend !== 0 && (
            <span className={`flex items-center text-xs font-medium px-2 py-1 rounded-full ${agentTrend > 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-rose-50 text-rose-500'}`}>
              {agentTrend > 0 ? <TrendingUp className="w-3 h-3 mr-0.5" /> : <TrendingDown className="w-3 h-3 mr-0.5" />}
              {Math.abs(agentTrend)}%
            </span>
          )}
        </div>

        {/* Chart */}
        <div className="flex-1 flex items-center justify-center relative py-2">
          <div className="w-[110px] h-[110px]">
            <Doughnut data={doughnutData} options={doughnutOptions} />
          </div>
          {/* Center label */}
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-2xl font-bold text-black">{totalAgents}</span>
            <span className="text-[10px] text-black/40 uppercase tracking-wide">Total</span>
          </div>
        </div>

        {/* Legend */}
        <div className="flex items-center justify-center gap-4 pt-3 border-t border-black/5">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-cyan-500" />
            <span className="text-xs text-black/60">{productionAgents} prod</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-purple-500" />
            <span className="text-xs text-black/60">{testingAgents} test</span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OverviewHeroChart;
