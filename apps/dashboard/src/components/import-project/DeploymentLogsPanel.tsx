"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Terminal } from "@xterm/xterm";
import { Icon as UiIcon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { LogTerminalContext } from "@/components/terminal/LogTerminalContext";
import { TerminalSearch } from "@/components/terminal/TerminalSearch";
import { TerminalFollowControls } from "@/components/terminal/TerminalFollowControls";
import { useTerminalFollow } from "@/components/terminal/useTerminalFollow";
import { useTerminalSearch } from "@/components/terminal/useTerminalSearch";
import { terminalText } from "@/components/terminal/terminal-text";
import { useToast } from "@/context/ToastContext";
import { copyText } from "@/lib/clipboard";

/** The same console surface for single-app and Compose deployments. */
export function DeploymentLogsPanel({
  title,
  summary,
  children,
}: {
  title: string;
  summary?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const copy = t.projectDetail.logs;
  const [terminal, setTerminal] = useState<Terminal | null>(null);
  const [copied, setCopied] = useState(false);
  const currentTerminal = useRef(terminal);
  currentTerminal.current = terminal;
  const follow = useTerminalFollow(terminal);
  const search = useTerminalSearch(terminal, follow.pauseForInspection);
  const [olderOutputDiscarded, setOlderOutputDiscarded] = useState(false);

  useEffect(() => {
    setOlderOutputDiscarded(false);
    if (!terminal) return;
    const writes = terminal.onWriteParsed(() => {
      setOlderOutputDiscarded(terminal.buffer.active.baseY >= (terminal.options.scrollback ?? 1000));
    });
    return () => writes.dispose();
  }, [terminal]);

  useEffect(() => {
    if (search.error) showToast(search.error.message, "error", copy.terminal.logsErrorTitle);
  }, [search.error, showToast, copy.terminal.logsErrorTitle]);
  useEffect(() => { setCopied(false); }, [terminal]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    if (!terminal) return;
    setCopied(false);
    try {
      const text = terminalText(terminal);
      if (!text) return;
      await copyText(text);
      if (currentTerminal.current === terminal) setCopied(true);
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "dashboard/components/import-project/DeploymentLogsPanel");
      showToast(t.projectSettings.advanced.projectMenu.copyFailed, "error");
    }
  };

  return (
    <LogTerminalContext.Provider value={setTerminal}>
      <section className="@container min-w-0 overflow-hidden rounded-2xl bg-card">
        <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
          <div className="flex min-w-0 flex-1 items-center gap-3 @2xl:max-w-[45%] @2xl:flex-none">
            <h2 className="shrink-0 text-sm font-semibold text-foreground">{title}</h2>
            {summary}
          </div>
          <div className="order-last flex w-full min-w-0 flex-wrap items-center gap-2 @2xl:order-none @2xl:w-auto @2xl:flex-1">
            <div className="min-w-0 flex-1 basis-56">
              <TerminalSearch {...search} />
            </div>
            <TerminalFollowControls
              isFollowing={follow.isFollowing}
              onToggle={follow.toggle}
              onJumpToLatest={follow.resume}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={handleCopy}
            disabled={!terminal}
            title={copied ? copy.actions.copied : copy.actions.copy}
            aria-label={copied ? copy.actions.copied : copy.actions.copy}
            className="shrink-0"
          >
            <UiIcon name={copied ? "check" : "copy"} aria-hidden className={`size-4 ${copied ? "text-success" : ""}`} />
          </Button>
        </div>
        {olderOutputDiscarded && (
          <p className="px-4 pb-3 text-xs text-muted-foreground sm:px-5" role="status">
            {copy.terminal.olderOutputDiscarded}
          </p>
        )}
        <div className="relative h-[clamp(420px,65vh,720px)] overflow-hidden">{children}</div>
      </section>
    </LogTerminalContext.Provider>
  );
}
