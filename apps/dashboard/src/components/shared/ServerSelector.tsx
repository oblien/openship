"use client";

import { useState, useEffect, useCallback } from "react";
import { BlurIp } from "@/components/BlurIp";
import {
  Server,
  CheckCircle2,
  ChevronDown,
  Plus,
  Loader2,
} from "lucide-react";
import { systemApi, type ServerInfo } from "@/lib/api/system";
import { useI18n } from "@/components/i18n-provider";
import { useAddServerModal } from "@/components/servers/add-server-modal";
import { DismissiblePopover } from "@/components/ui/Popover";

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
  /**
   * Server ids to leave OUT of the list — a destination picker for a flow that already
   * involves a server ("move this project to another server" must not offer the one it is
   * already on, and the API refuses that anyway).
   *
   * Filtered after the fetch, so the auto-select rules below count only what remains: with
   * one other server left, that one still auto-selects.
   */
  excludeIds?: string[];
  /**
   * Replaces the empty state's second line. With {@link excludeIds} the list can be empty
   * while servers DO exist, and "No server connected" would then be a lie — the caller says
   * what is actually missing ("Add a second server to move this project to one"). The
   * action is unchanged: adding one is still the way out.
   */
  emptyHint?: string;
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
  excludeIds,
  emptyHint,
}: ServerSelectorProps) {
  const { t } = useI18n();
  const w = t.widgets.shared.serverSelector;
  const labelText = label ?? w.serverLabel;
  const [servers, setServers] = useState<ServerOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const openAddServer = useAddServerModal();

  // A caller that passes no `value` is uncontrolled, so mirror our own picks
  // here. The dropdown resolves the selection by id, and `undefined` matches no
  // server — without this an uncontrolled host would read "select a server"
  // forever despite having auto-selected one.
  const [internalId, setInternalId] = useState<string | null>(null);
  const effectiveValue = value === undefined ? internalId : value;

  const fetchServers = useCallback(async () => {
    try {
      setLoading(true);
      const all = await systemApi.listServers();
      // Excluded BEFORE the auto-select below, so "one server" means one CHOOSABLE server.
      const skip = new Set(excludeIds ?? []);
      const list = skip.size > 0 ? all.filter((s) => !skip.has(s.id)) : all;
      if (list.length > 0) {
        const opts = list.map(serverInfoToOption);
        setServers(opts);
        // Auto-select the lone server, or the first one when the caller asked
        // for a default and nothing's chosen yet (captured initial `value`).
        if (opts.length === 1 || (autoSelectFirst && !value)) {
          setInternalId(opts[0].id);
          onSelect(opts[0]);
        }
      } else {
        setServers([]);
        setInternalId(null);
        onSelect(null);
      }
    } catch {
      setServers([]);
      setInternalId(null);
      onSelect(null);
    } finally {
      setLoading(false);
    }
  // `onSelect` stays out (same-callback-identity contract as before), but the exclusion
  // must be in: a host that changes it and keeps the old list would offer a server the
  // flow has just ruled out. Joined rather than passed by reference — callers build the
  // array inline, so a fresh identity every render would refetch forever.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(excludeIds ?? []).join(",")]);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  // Adding a server never leaves the flow: the panel opens on top, and the
  // saved row is spliced in and selected so the caller can carry straight on.
  // createServerEntry returns the full row, so no refetch is needed.
  const addServer = useCallback(() => {
    openAddServer((created: ServerInfo) => {
      const opt = serverInfoToOption(created);
      setServers((prev) => (prev.some((p) => p.id === opt.id) ? prev : [...prev, opt]));
      setInternalId(opt.id);
      onSelect(opt);
    });
  }, [openAddServer, onSelect]);

  const selected = servers.find((s) => s.id === effectiveValue) ?? null;

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
    // Compact hosts (picker rows inside wizards and modals) get a single
    // clickable row instead of a full-height hero — same action, no layout jump.
    if (compact) {
      return (
        <button
          type="button"
          onClick={addServer}
          disabled={disabled}
          className="w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border border-dashed border-border text-start transition-colors hover:bg-muted/20 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <Plus className="size-4 text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">{w.addServer}</p>
            <p className="text-xs text-muted-foreground truncate">
              {emptyHint ?? w.noServerConnected}
            </p>
          </div>
        </button>
      );
    }

    // Full hosts are FORMS, not empty pages: this sits in a column of labelled
    // full-width fields, so it renders as one of them — same label, same width,
    // same left edge. It used to be a centered `max-w-sm` hero padded with
    // py-16, which in a wide card was a narrow island floating in dead space
    // above left-aligned inputs.
    return (
      <div className="mb-5">
        <label className="block text-sm font-medium text-foreground mb-1.5">
          {labelText}
        </label>
        <div className="flex flex-col gap-3 rounded-xl border border-dashed border-border bg-muted/[0.15] p-4 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
              <Server className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0">
              {/* With `emptyHint` servers DO exist (they were excluded), so the
                  "no server connected" headline would be a lie — the caller's
                  sentence takes the headline slot instead of trailing one. */}
              <p className="text-sm font-medium text-foreground">
                {emptyHint ?? w.noServerConnected}
              </p>
              {!emptyHint && (
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {w.connectServerFirst}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={addServer}
            disabled={disabled}
            className="inline-flex w-full sm:w-auto shrink-0 items-center justify-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Plus className="size-4" />
            {w.addServer}
          </button>
        </div>
      </div>
    );
  }

  /* ── Servers - dropdown ────────────────────────────────────────────── */

  /**
   * ONE server is not a special case. It used to get a bespoke static row with
   * an "add server" text button bolted underneath, which meant a one-server box
   * offered a different control — and a different way to reach "add server" —
   * than a two-server box asking the identical question. The dropdown already
   * renders a 1-item list and already carries the add-server row in its menu, so
   * the branch bought nothing and cost the two pickers agreeing with each other.
   */
  return (
    <div className={compact ? "" : "mb-5"}>
      {!compact && (
        <label className="block text-sm font-medium text-foreground mb-1.5">
          {labelText}
        </label>
      )}
      <DismissiblePopover open={open} onOpenChange={setOpen} className="relative">
        <button
          type="button"
          onClick={() => !disabled && setOpen(!open)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
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
                  {selected.user}@<BlurIp>{selected.host}</BlurIp>:{selected.port}
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
            role="listbox"
            className={`absolute z-50 start-0 end-0 max-h-64 overflow-auto rounded-xl border border-border bg-popover shadow-lg ${
              dropUp ? "bottom-full mb-1.5" : "mt-1.5"
            }`}
          >
            {servers.map((s) => (
              <button
                key={s.id}
                type="button"
                role="option"
                aria-selected={effectiveValue === s.id}
                onClick={() => {
                  setInternalId(s.id);
                  onSelect(s);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-3 px-3.5 py-3 text-start transition-colors hover:bg-muted/40 ${
                  effectiveValue === s.id ? "bg-muted/30" : ""
                }`}
              >
                <div className="w-8 h-8 rounded-lg bg-success-bg flex items-center justify-center shrink-0">
                  <Server className="size-4 text-success" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">{s.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {s.user}@<BlurIp>{s.host}</BlurIp>:{s.port}
                  </p>
                </div>
                {effectiveValue === s.id && (
                  <CheckCircle2 className="size-4 text-success shrink-0" />
                )}
              </button>
            ))}

            <div className="border-t border-border/50">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  addServer();
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
      </DismissiblePopover>
    </div>
  );
}
