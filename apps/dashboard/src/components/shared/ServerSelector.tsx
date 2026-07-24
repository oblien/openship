"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Server,
  CheckCircle2,
  ChevronDown,
  Plus,
  Loader2,
} from "lucide-react";
import { systemApi, type ServerInfo } from "@/lib/api/system";
import { useI18n } from "@/components/i18n-provider";

/* ── Types ──────────────────────────────────────────────────────────── */

export interface ServerOption {
  id: string;
  name: string;
  host: string;
  user: string;
  port: number;
  raw: ServerInfo;
}

export interface ServerSelectorProps {
  /** Called when a server is selected (or null when deselected) */
  onSelect: (server: ServerOption | null) => void;
  /** Currently selected server id */
  value?: string | null;
  /** Label above the selector */
  label?: string;
  /** Disable interaction */
  disabled?: boolean;
  /** Show compact variant (no label) */
  compact?: boolean;
  /** Open the dropdown upward (for selectors pinned near the bottom of a modal). */
  dropUp?: boolean;
  /**
   * Pre-select the first server on load even when there are several (nothing
   * chosen yet). A lone server always auto-selects; this extends that to the
   * "many servers" case so an install wizard opens with a destination already
   * picked. Off by default — flows that must not guess (adopt / migrate) skip it.
   */
  autoSelectFirst?: boolean;
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function serverInfoToOption(s: ServerInfo): ServerOption {
  return {
    id: s.id,
    name: s.name || s.sshHost,
    host: s.sshHost,
    user: s.sshUser || "root",
    port: s.sshPort ?? 22,
    raw: s,
  };
}

/* ── Component ──────────────────────────────────────────────────────── */

export default function ServerSelector({
  onSelect,
  value,
  label,
  disabled = false,
  compact = false,
  dropUp = false,
  autoSelectFirst = false,
}: ServerSelectorProps) {
  const router = useRouter();
  const { t } = useI18n();
  const w = t.widgets.shared.serverSelector;
  const labelText = label ?? w.serverLabel;
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  const fetchServers = useCallback(async () => {
    try {
      setLoading(true);
      const list = await systemApi.listServers();
      if (list.length > 0) {
        const opts = list.map(serverInfoToOption);
        setServers(opts);
        // Auto-select the lone server, or the first one when the caller asked
        // for a default and nothing's chosen yet (captured initial `value`).
        if (opts.length === 1 || (autoSelectFirst && !value)) onSelect(opts[0]);
      } else {
        setServers([]);
        onSelect(null);
      }
    } catch {
      setServers([]);
      onSelect(null);
    } finally {
      setLoading(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // onSelect intentionally excluded - same-cb identity contract as before

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  const selected = servers.find((s) => s.id === value) ?? null;

  /* ── Loading state ─────────────────────────────────────────────────── */

  if (loading) {
    return (
      <div className={compact ? "" : "mb-5"}>
        {!compact && (
          <label className="block text-sm font-medium text-foreground mb-1.5">
            {labelText}
          </label>
        )}
        <div className="flex items-center gap-3 px-3.5 py-3 rounded-xl border border-border/50 bg-muted/20">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">{w.loadingServers}</span>
        </div>
      </div>
    );
  }

  /* ── No servers - empty state ──────────────────────────────────────── */

  if (servers.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="max-w-sm w-full text-center">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-muted/60 flex items-center justify-center mb-4">
            <Server className="size-5 text-muted-foreground/60" />
          </div>
          <h3 className="text-base font-medium text-foreground mb-1.5">
            {w.noServerConnected}
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed mb-5">
            {w.connectServerFirst}
          </p>
          <button
            onClick={() => router.push("/servers/new")}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25"
          >
            <Plus className="size-4" />
            {w.addServer}
          </button>
        </div>
      </div>
    );
  }

  /* ── Single server - auto-selected display ─────────────────────────── */

  if (servers.length === 1) {
    const s = servers[0];
    return (
      <div className={compact ? "" : "mb-5"}>
        {!compact && (
          <label className="block text-sm font-medium text-foreground mb-1.5">
            {labelText}
          </label>
        )}
        <div className="flex items-center gap-3 px-3.5 py-3 rounded-xl border border-border/50 bg-muted/30">
          <div className="w-8 h-8 rounded-lg bg-success-bg flex items-center justify-center shrink-0">
            <Server className="size-4 text-success" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{s.name}</p>
            <p className="text-xs text-muted-foreground">
              {s.user}@{s.host}:{s.port}
            </p>
          </div>
          <CheckCircle2 className="size-4 text-success shrink-0" />
        </div>
      </div>
    );
  }

  /* ── Multiple servers - dropdown ───────────────────────────────────── */

  return (
    <div className={compact ? "" : "mb-5"}>
      {!compact && (
        <label className="block text-sm font-medium text-foreground mb-1.5">
          {label}
        </label>
      )}
      <div className="relative">
        <button
          type="button"
          onClick={() => !disabled && setOpen(!open)}
          disabled={disabled}
          className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border border-border/50 bg-background hover:bg-muted/20 transition-colors text-start disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {selected ? (
            <>
              <div className="w-8 h-8 rounded-lg bg-success-bg flex items-center justify-center shrink-0">
                <Server className="size-4 text-success" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground truncate">
                  {selected.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {selected.user}@{selected.host}:{selected.port}
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                <Server className="size-4 text-muted-foreground" />
              </div>
              <span className="text-sm text-muted-foreground">{w.selectServer}</span>
            </>
          )}
          <ChevronDown
            className={`size-4 text-muted-foreground shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open && (
          <div
            className={`absolute z-50 start-0 end-0 max-h-64 overflow-auto rounded-xl border border-border bg-popover shadow-lg ${
              dropUp ? "bottom-full mb-1.5" : "mt-1.5"
            }`}
          >
            {servers.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  onSelect(s);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-3 text-start transition-colors hover:bg-muted/40 ${
                  value === s.id ? "bg-muted/30" : ""
                }`}
              >
                <div className="w-8 h-8 rounded-lg bg-success-bg flex items-center justify-center shrink-0">
                  <Server className="size-4 text-success" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{s.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.user}@{s.host}:{s.port}
                  </p>
                </div>
                {value === s.id && (
                  <CheckCircle2 className="size-4 text-success shrink-0" />
                )}
              </button>
            ))}

            <div className="border-t border-border/50">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  router.push("/servers/new");
                }}
                className="w-full flex items-center gap-3 px-3.5 py-3 text-start transition-colors hover:bg-muted/40"
              >
                <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <Plus className="size-4 text-muted-foreground" />
                </div>
                <span className="text-sm text-muted-foreground">{w.addNewServer}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
