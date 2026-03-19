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
  label = "Server",
  disabled = false,
  compact = false,
}: ServerSelectorProps) {
  const router = useRouter();
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
        // Auto-select if only one
        if (opts.length === 1) onSelect(opts[0]);
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
  }, []); // onSelect intentionally excluded — we only call on mount

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
            {label}
          </label>
        )}
        <div className="flex items-center gap-3 px-3.5 py-3 rounded-xl border border-border/50 bg-muted/20">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Loading servers…</span>
        </div>
      </div>
    );
  }

  /* ── No servers — empty state ──────────────────────────────────────── */

  if (servers.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <div className="max-w-sm w-full text-center">
          <div className="mx-auto w-12 h-12 rounded-2xl bg-muted/60 flex items-center justify-center mb-4">
            <Server className="size-5 text-muted-foreground/60" />
          </div>
          <h3 className="text-base font-medium text-foreground mb-1.5">
            No server connected
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed mb-5">
            Connect a server first, then come back to continue setup.
          </p>
          <button
            onClick={() => router.push("/servers/new")}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25"
          >
            <Plus className="size-4" />
            Add Server
          </button>
        </div>
      </div>
    );
  }

  /* ── Single server — auto-selected display ─────────────────────────── */

  if (servers.length === 1) {
    const s = servers[0];
    return (
      <div className={compact ? "" : "mb-5"}>
        {!compact && (
          <label className="block text-sm font-medium text-foreground mb-1.5">
            {label}
          </label>
        )}
        <div className="flex items-center gap-3 px-3.5 py-3 rounded-xl border border-border/50 bg-muted/30">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
            <Server className="size-4 text-emerald-500" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground truncate">{s.name}</p>
            <p className="text-xs text-muted-foreground">
              {s.user}@{s.host}:{s.port}
            </p>
          </div>
          <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
        </div>
      </div>
    );
  }

  /* ── Multiple servers — dropdown ───────────────────────────────────── */

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
          className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border border-border/50 bg-background hover:bg-muted/20 transition-colors text-left disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {selected ? (
            <>
              <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                <Server className="size-4 text-emerald-500" />
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
              <span className="text-sm text-muted-foreground">Select a server…</span>
            </>
          )}
          <ChevronDown
            className={`size-4 text-muted-foreground shrink-0 transition-transform ${open ? "rotate-180" : ""}`}
          />
        </button>

        {open && (
          <div className="absolute z-50 left-0 right-0 mt-1.5 bg-card rounded-xl border border-border shadow-lg overflow-hidden">
            {servers.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  onSelect(s);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-muted/40 ${
                  value === s.id ? "bg-muted/30" : ""
                }`}
              >
                <div className="w-8 h-8 rounded-lg bg-emerald-500/10 flex items-center justify-center shrink-0">
                  <Server className="size-4 text-emerald-500" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{s.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.user}@{s.host}:{s.port}
                  </p>
                </div>
                {value === s.id && (
                  <CheckCircle2 className="size-4 text-emerald-500 shrink-0" />
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
                className="w-full flex items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-muted/40"
              >
                <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                  <Plus className="size-4 text-muted-foreground" />
                </div>
                <span className="text-sm text-muted-foreground">Add new server…</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
