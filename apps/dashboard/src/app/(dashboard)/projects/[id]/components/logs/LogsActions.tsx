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
    <div className="flex items-center gap-1.5">
      {/* Copy */}
      <button
        onClick={onCopy}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-muted/60 rounded-md transition-colors text-xs text-muted-foreground hover:text-foreground"
      >
        {copied ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>

      {/* Download */}
      <button
        onClick={onDownload}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-muted/60 rounded-md transition-colors text-xs text-muted-foreground hover:text-foreground"
      >
        <Download className="w-3.5 h-3.5" />
        Download
      </button>

      {/* Clear */}
      <button
        onClick={onClear}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 hover:bg-red-500/10 rounded-md transition-colors text-xs text-muted-foreground hover:text-red-600"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        Clear
      </button>
    </div>
  );
};

