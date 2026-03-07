"use client";

import React from "react";
import { Download, RefreshCw, Copy, Check } from "lucide-react";

interface LogsActionsProps {
  onCopy: () => void;
  onDownload: () => void;
  onClear: () => void;
  copied: boolean;
  logsCount: number;
}

export const LogsActions: React.FC<LogsActionsProps> = ({
  onCopy,
  onDownload,
  onClear,
  copied,
  logsCount,
}) => {
  return (
    <div className="flex items-center gap-2">
      {/* Copy */}
      <button
        onClick={onCopy}
        className="flex items-center gap-1.5 px-3.5 py-2 bg-white hover:bg-gray-50 border border-black/10 hover:border-black/20 rounded-lg transition-all text-xs font-medium text-black shadow-sm"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>

      {/* Download */}
      <button
        onClick={onDownload}
        className="flex items-center gap-1.5 px-3.5 py-2 bg-white hover:bg-gray-50 border border-black/10 hover:border-black/20 rounded-lg transition-all text-xs font-medium text-black shadow-sm"
      >
        <Download className="w-3.5 h-3.5" />
        Download
      </button>

      {/* Clear */}
      <button
        onClick={onClear}
        className="flex items-center gap-1.5 px-3.5 py-2 bg-white hover:bg-red-50 border border-red-200 hover:border-red-300 text-red-600 hover:text-red-700 rounded-lg transition-all text-xs font-medium shadow-sm"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        Clear
      </button>
    </div>
  );
};

