"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React from "react";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

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
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap items-center gap-1">
      {/* Copy */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onCopy}
        disabled={logsCount === 0}
        className="h-9"
      >
        {copied ? <UiIcon name="check" className="w-3.5 h-3.5 text-success" /> : <UiIcon name="copy" className="w-3.5 h-3.5" />}
        {copied ? t.projectDetail.logs.actions.copied : t.projectDetail.logs.actions.copy}
      </Button>

      {/* Download */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onDownload}
        disabled={logsCount === 0}
        className="h-9"
      >
        <UiIcon name="download" className="w-3.5 h-3.5" />
        {t.projectDetail.logs.actions.download}
      </Button>

      {/* Clear */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onClear}
        disabled={logsCount === 0}
        className="h-9 hover:bg-danger-bg hover:text-danger"
      >
        <UiIcon name="refresh" className="w-3.5 h-3.5" />
        {t.projectDetail.logs.actions.clear}
      </Button>
    </div>
  );
};
