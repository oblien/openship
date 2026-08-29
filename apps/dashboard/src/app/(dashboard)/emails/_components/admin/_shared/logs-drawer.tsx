"use client";

/**
 * Daemon log drawer for the Health tab. Slides in from the right, locks body
 * scroll, ESC + backdrop close.
 *
 * The header prints the read the SERVER performed (`logs.source`) rather than a
 * command this file composes. It used to hardcode `journalctl -u <unit>`, which on
 * the container engine named a log that does not exist — the real read is
 * `docker exec openship-mail tail -n N /var/log/supervisor/<unit>.log`. Re-deriving
 * it here would only move the guess client-side; only the box knows its topology.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCcw, X } from "lucide-react";
import { mailAdminApi, type ComponentLogs } from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface LogsDrawerProps {
  serverId: string;
  componentKey: string;
  label: string;
  onClose: () => void;
}

export function LogsDrawer({
  serverId,
  componentKey,
  label,
  onClose,
}: LogsDrawerProps) {
  const { t, dir } = useI18n();
  const [logs, setLogs] = useState<ComponentLogs | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await mailAdminApi.components.logs(serverId, componentKey, 300);
      setLogs(r);
      requestAnimationFrame(() => {
        if (scrollRef.current) {
          scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : t.emailsAdmin.shared.logsLoadFailed);
    } finally {
      setLoading(false);
    }
  }, [serverId, componentKey]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className={`fixed inset-0 z-[9999] flex bg-black/50 backdrop-blur-[2px] animate-in fade-in duration-150 ${
        dir === "rtl" ? "justify-start" : "justify-end"
      }`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`relative w-full max-w-2xl h-full bg-card border-s border-border shadow-2xl flex flex-col animate-in duration-200 ${
          dir === "rtl" ? "slide-in-from-left" : "slide-in-from-right"
        }`}
      >
        <div className="flex items-start gap-3 px-5 py-4 border-b border-border/50">
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">
              {interpolate(t.emailsAdmin.shared.logsTitle, { label })}
            </h2>
            <p className="text-[11.5px] text-muted-foreground mt-0.5 font-mono break-all">
              {logs?.source}
            </p>
          </div>
          <button
            onClick={load}
            disabled={loading}
            title={t.emailsAdmin.shared.reload}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-40"
          >
            {loading ? (
              <Loader2 className="size-3.5 animate-spin" strokeWidth={2.25} />
            ) : (
              <RefreshCcw className="size-3.5" strokeWidth={2.25} />
            )}
          </button>
          <button
            onClick={onClose}
            title={t.emailsAdmin.shared.close}
            className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <X className="size-4" strokeWidth={2} />
          </button>
        </div>
        <div
          ref={scrollRef}
          className="flex-1 overflow-auto bg-muted/20 font-mono text-[11.5px] leading-relaxed text-foreground/90 px-5 py-3"
        >
          {error ? (
            <p className="text-danger">{error}</p>
          ) : loading && !logs ? (
            <p className="text-muted-foreground">{t.emailsAdmin.shared.loadingLogs}</p>
          ) : logs && logs.lines.length === 0 ? (
            <p className="text-muted-foreground italic">
              {t.emailsAdmin.shared.noLogLines}
            </p>
          ) : (
            logs?.lines.map((line, i) => (
              <div key={i} className="whitespace-pre-wrap break-all">
                {line}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
