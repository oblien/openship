"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Terminal } from "@xterm/xterm";
import { Icon as UiIcon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { LogTerminalContext } from "@/components/terminal/LogTerminalContext";
import { TerminalSearch } from "@/components/terminal/TerminalSearch";
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
  const search = useTerminalSearch(terminal);

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
    } catch {
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
          <div className="order-last w-full min-w-0 @2xl:order-none @2xl:w-auto @2xl:flex-1">
            <TerminalSearch {...search} />
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
        <div className="relative h-[clamp(280px,50vh,400px)] overflow-hidden">{children}</div>
      </section>
    </LogTerminalContext.Provider>
  );
}
