"use client";

import { useEffect, useState } from "react";
import { Terminal, Maximize2, Minimize2 } from "lucide-react";
import { ServerTerminalTabs } from "@/components/terminal/ServerTerminalTabs";
import { useI18n } from "@/components/i18n-provider";

interface TerminalTabProps {
  serverId: string;
  serverName?: string;
  /** Drives the WS lifecycle - only open while the tab is active so we
   *  don't keep PTYs alive in the background. */
  enabled: boolean;
}

export function TerminalTab({ serverId, serverName, enabled }: TerminalTabProps) {
  const { t } = useI18n();
  // Fullscreen the terminal into a viewport overlay. ServerTerminal runs a
  // ResizeObserver → FitAddon.fit(), so xterm reflows automatically when the
  // container grows/shrinks — no manual refit needed on toggle.
  const [expanded, setExpanded] = useState(false);

  // Esc leaves fullscreen (bound only while expanded).
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const expandLabel = expanded ? t.misc.terminalTabs.collapse : t.misc.terminalTabs.expand;

  return (
    <div className={expanded ? "fixed inset-0 z-50 flex bg-background/95 p-4 backdrop-blur-sm" : "space-y-4"}>
      <div
        className={
          "overflow-hidden rounded-2xl border border-border/50 bg-card" +
          (expanded ? " flex h-full w-full flex-col" : "")
        }
      >
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border/50 px-5 py-4">
          <div className="flex size-9 items-center justify-center rounded-xl bg-muted ring-1 ring-border/50">
            <Terminal className="size-[18px] text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-foreground">
              {t.servers.terminal.title} {serverName ? <span className="text-muted-foreground">· {serverName}</span> : null}
            </h2>
            <p className="text-xs text-muted-foreground">
              {t.servers.terminal.description}
            </p>
          </div>
          {/* Expand / collapse — fills the empty header space on the right. */}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-label={expandLabel}
            title={expandLabel}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-xl text-muted-foreground ring-1 ring-border/50 transition-colors hover:bg-muted hover:text-foreground"
          >
            {expanded ? <Minimize2 className="size-[18px]" /> : <Maximize2 className="size-[18px]" />}
          </button>
        </div>

        {/* Multi-shell tabs surface. Fixed height normally so xterm has
            something to fit against; fills the overlay when expanded. */}
        <div className={expanded ? "min-h-0 w-full flex-1" : "h-[60vh] min-h-[480px] w-full"}>
          <ServerTerminalTabs serverId={serverId} enabled={enabled} />
        </div>
      </div>
    </div>
  );
}
