"use client";

import React, { useState } from 'react';
import { Icon } from "@repo/ui/icons";

const InfoBanner = ({ title, children, content, icon, defaultExpanded = false }) => {
  const [expanded, setExpanded] = useState(defaultExpanded);

  // Support both children and content props for flexibility
  const bannerContent = content || children;
  const bannerIcon = <Icon name="info" className="w-5 h-5 text-indigo-600 flex-shrink-0" />;

  return (
    <div className="bg-indigo-50 rounded-[20px] border border-indigo-100 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full p-5 flex items-center justify-between hover:bg-indigo-100/50 transition-colors"
      >
        <div className="flex items-center space-x-3">
          {bannerIcon}
          <h4 className="text-sm font-semibold text-indigo-900">{title}</h4>
        </div>
        {expanded ? (
          <Icon name="chevron-up" className="w-5 h-5 text-indigo-600" />
        ) : (
          <Icon name="chevron-down" className="w-5 h-5 text-indigo-600" />
        )}
      </button>
      {expanded && bannerContent && (
        <div className="px-5 pb-5">
          {bannerContent}
        </div>
      )}
    </div>
  );
};

export default InfoBanner;

