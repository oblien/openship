'use client';

import React from 'react';
import Link from 'next/link';
import { Wallet, Plus, TrendingUp } from 'lucide-react';

interface OverviewHeaderProps {
  userName?: string;
  creditsBalance?: string | number;
}

const OverviewHeader: React.FC<OverviewHeaderProps> = ({ 
  userName,
  creditsBalance = 0,
}) => {
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  };

  const formatCredits = (value: string | number): string => {
    // If already formatted string (with K/M), just add $
    if (typeof value === 'string') {
      return `$${value}`;
    }
    // If number, format with 2 decimals
    return `$${value.toFixed(2)}`;
  };

  return (
    <div className="mb-8">
      <div className="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-6">
        {/* Left: Greeting */}
        <div>
          <h1 className="text-3xl font-bold text-black mb-1.5" style={{ letterSpacing: '-0.5px' }}>
            {userName ? `${getGreeting()}, ${userName}` : 'Overview'}
          </h1>
          <p className="text-sm text-black/50">
            Monitor your platform usage and manage resources
          </p>
        </div>
        
        {/* Right: Credits Card */}
        <div className="bg-white rounded-[20px] border border-black/5 p-5 min-w-[320px]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 bg-black/[0.04] rounded-xl flex items-center justify-center">
                <Wallet className="w-5 h-5 text-black/60" />
              </div>
              <div>
                <p className="text-xs text-black/40 mb-0.5">Credits Balance</p>
                <span className="text-2xl font-bold text-black">
                  {formatCredits(creditsBalance)}
                </span>
              </div>
            </div>
            
            <Link
              href="/billing"
              className="flex items-center gap-1.5 px-4 py-2.5 bg-black text-white text-sm font-medium rounded-xl hover:bg-black/80 transition-colors ml-4"
            >
              <Plus className="w-4 h-4" />
              Top Up
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OverviewHeader;
