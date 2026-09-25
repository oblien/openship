'use client';

import { Icon as UiIcon } from "@repo/ui/icons";

import React from 'react';
import Link from 'next/link';
import { useI18n, interpolate } from '@/components/i18n-provider';

interface OverviewHeaderProps {
  userName?: string;
  creditsBalance?: string | number;
}

const OverviewHeader: React.FC<OverviewHeaderProps> = ({
  userName,
  creditsBalance = 0,
}) => {
  const { t } = useI18n();

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return t.overview.header.goodMorning;
    if (hour < 18) return t.overview.header.goodAfternoon;
    return t.overview.header.goodEvening;
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
            {userName
              ? interpolate(t.overview.header.greetingWithName, { greeting: getGreeting(), name: userName })
              : t.overview.header.overview}
          </h1>
          <p className="text-sm text-black/50">
            {t.overview.header.subtitle}
          </p>
        </div>
        
        {/* Right: Credits Card */}
        <div className="bg-white rounded-[20px] border border-black/5 p-5 min-w-[320px]">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-11 h-11 bg-black/[0.04] rounded-xl flex items-center justify-center">
                <UiIcon name="wallet" className="w-5 h-5 text-black/60" />
              </div>
              <div>
                <p className="text-xs text-black/40 mb-0.5">{t.overview.header.creditsBalance}</p>
                <span className="text-2xl font-bold text-black">
                  {formatCredits(creditsBalance)}
                </span>
              </div>
            </div>
            
            <Link
              href="/billing"
              className="flex items-center gap-1.5 px-4 py-2.5 bg-black text-white text-sm font-medium rounded-xl hover:bg-black/80 transition-colors ms-4"
            >
              <UiIcon name="plus" className="w-4 h-4" />
              {t.overview.header.topUp}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};

export default OverviewHeader;
