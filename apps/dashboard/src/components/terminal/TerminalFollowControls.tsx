"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

interface TerminalFollowControlsProps {
  isFollowing: boolean;
  onToggle: () => void;
  onJumpToLatest: () => void;
}

export function TerminalFollowControls({
  isFollowing,
  onToggle,
  onJumpToLatest,
}: TerminalFollowControlsProps) {
  const { t } = useI18n();
  const copy = t.projectDetail.logs.terminal;

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {!isFollowing && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onJumpToLatest}
          className="h-9 gap-1.5 px-2.5"
        >
          <UiIcon name="chevron-down" aria-hidden className="size-3.5" />
          <span>{copy.jumpToLatest}</span>
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onToggle}
        aria-label={isFollowing ? copy.pauseFollowing : copy.resumeFollowing}
        title={isFollowing ? copy.pauseFollowing : copy.resumeFollowing}
        className="h-9 gap-1.5 px-2.5"
      >
        <UiIcon name={isFollowing ? "pause" : "play"} aria-hidden className="size-3.5" />
        <span>{isFollowing ? copy.pauseFollowing : copy.resumeFollowing}</span>
      </Button>
    </div>
  );
}
