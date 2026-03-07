import React from "react";
import { generateIcon } from "@/utils/icons";

interface UsageStatsProps {
  timeframe?: string;
}

const UsageStats: React.FC<UsageStatsProps> = ({ timeframe = "Last 30 days" }) => {
  return (
    <div className="bg-white rounded-xl border border-black/10 p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-sm font-semibold text-black">Usage</h3>
        <span className="text-xs text-black/50">{timeframe}</span>
      </div>

      <div className="space-y-4">
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {generateIcon('activity-50-1658433844.png', 16, 'rgba(0,0,0,0.5)')}
              <span className="text-sm text-black/70">Edge Requests</span>
            </div>
            <span className="text-sm  text-black">20K / 1M</span>
          </div>
          <div className="w-full bg-black/5 rounded-full h-1.5">
            <div className="bg-black h-1.5 rounded-full" style={{ width: '2%' }}></div>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {generateIcon('database-20-1658238246.png', 16, 'rgba(0,0,0,0.5)')}
              <span className="text-sm text-black/70">ISR Reads</span>
            </div>
            <span className="text-sm  text-black">12K / 1M</span>
          </div>
          <div className="w-full bg-black/5 rounded-full h-1.5">
            <div className="bg-black h-1.5 rounded-full" style={{ width: '1.2%' }}></div>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {generateIcon('data-transfer-19-1658238246.png', 16, 'rgba(0,0,0,0.5)')}
              <span className="text-sm text-black/70">Fast Origin Transfer</span>
            </div>
            <span className="text-sm  text-black">91 MB / 10 GB</span>
          </div>
          <div className="w-full bg-black/5 rounded-full h-1.5">
            <div className="bg-black h-1.5 rounded-full" style={{ width: '0.9%' }}></div>
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {generateIcon('send-30-1687505545.png', 16, 'rgba(0,0,0,0.5)')}
              <span className="text-sm text-black/70">Fast Data Transfer</span>
            </div>
            <span className="text-sm  text-black">312 MB / 100 GB</span>
          </div>
          <div className="w-full bg-black/5 rounded-full h-1.5">
            <div className="bg-black h-1.5 rounded-full" style={{ width: '0.3%' }}></div>
          </div>
        </div>
      </div>

      <button className="w-full mt-4 px-4 py-2 bg-black text-white text-sm font-medium rounded-lg hover:bg-black/90 transition-all">
        Upgrade
      </button>
    </div>
  );
};

export default UsageStats;


