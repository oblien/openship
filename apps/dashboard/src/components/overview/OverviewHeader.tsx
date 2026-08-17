'use client';

import React from 'react';
import { useI18n, interpolate } from '@/components/i18n-provider';

interface OverviewHeaderProps {
  userName?: string;
}

const OverviewHeader: React.FC<OverviewHeaderProps> = ({
  userName,
}) => {
  const { t } = useI18n();

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return t.overview.header.goodMorning;
    if (hour < 18) return t.overview.header.goodAfternoon;
    return t.overview.header.goodEvening;
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
      </div>
    </div>
  );
};

export default OverviewHeader;
