"use client";

/**
 * Multi-shell tab strip for a single server.
 *
 * Layout: a horizontal tab bar over a stack of <ServerTerminal>s,
 * where exactly one is `visible` at a time and the others sit hidden
 * with display:none. ALL of them keep their WS open so output keeps
 * flowing into scrollback even on inactive tabs (matches VSCode's
 * "tabs run in background" behavior). Switching tabs triggers a
 * re-fit + focus on the newly-visible terminal.
 *
 * Limits: the API caps active sessions per user at
 * TERMINAL_MAX_SESSIONS_PER_USER (default 3). When the user opens
 * three shells, the "+" button is disabled and we surface a tooltip
 * explaining why. The cap is enforced server-side regardless — the
 * client gate is purely UX.
 *
 * Identity: each tab has a stable client-side `id` (used for React
 * keys + close lookups) plus a `label` (shown in the strip). Labels
 * are auto-assigned "Shell N" with N monotonically increasing across
 * the lifetime of the panel so closing #2 and opening a new one gives
 * "Shell 4", not a confusing reused "Shell 2".
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { ServerTerminal, type ServerTerminalHandle } from "./ServerTerminal";
import { useTheme } from "@/components/theme-provider";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { randomUUID } from "@/lib/random-uuid";

interface ServerTerminalTabsProps {
  serverId: string;
  /** Drives WS lifecycle for ALL shells. When the host (Terminal page
   *  tab) hides this, every shell's WS closes. */
  enabled: boolean;
  /** Hard upper bound — matches the server's per-user concurrent cap.
   *  Default 3 mirrors the API's TERMINAL_MAX_SESSIONS_PER_USER. */
  maxShells?: number;
  className?: string;
}

interface ShellEntry {
  id: string;
  label: string;
  /**
   * Server-issued resume token (null until the first `ready` frame).
   * Persisted to localStorage so page reload can reattach to the parked
   * session. The next `ready` (fresh or resumed) overwrites it; on
   * resume_failed or shell exit, ServerTerminal clears it via the
   * onResumeTokenChange callback.
   */
  resumeToken: string | null;
}

function genId(): string {
  // Crypto for collision-free IDs without pulling in a uuid dep. The secure
  // context fallback lives in the shared helper.
  return randomUUID();
}

const STORAGE_PREFIX = "openship.terminal.shells";

function storageKey(serverId: string): string {
  return `${STORAGE_PREFIX}.${serverId}`;
}

function loadShells(serverId: string): { shells: ShellEntry[]; counter: number } | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(storageKey(serverId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.shells)) return null;
    // Defensive: drop any entries with missing fields.
    const shells: ShellEntry[] = parsed.shells
      .filter((s: any) => s && typeof s.id === "string" && typeof s.label === "string")
      .map((s: any) => ({
        id: s.id,
        label: s.label,
        resumeToken: typeof s.resumeToken === "string" ? s.resumeToken : null,
      }));
    const counter = Number.isFinite(parsed.counter) ? Number(parsed.counter) : shells.length;
    return { shells, counter };
  } catch {
    return null;
  }
}

function saveShells(serverId: string, shells: ShellEntry[], counter: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      storageKey(serverId),
      JSON.stringify({ shells, counter }),
    );
  } catch {
    // localStorage can throw on quota / private mode — silently skip.
  }
}

export function ServerTerminalTabs({
  serverId,
  enabled,
  maxShells = 3,
  className = "",
}: ServerTerminalTabsProps) {
  const { resolvedTheme } = useTheme();
  const { t } = useI18n();
  const m = t.misc.terminalTabs;
  // Seed from localStorage if a prior session left state for this
  // server. On first mount we either get { shells: [...], counter: N }
  // from prior runs, or we fall back to a single fresh "Shell 1". The
  // counter persists across closes so labels don't collide with
  // already-closed shells.
  const counterRef = useRef(1);
  const [shells, setShells] = useState<ShellEntry[]>(() => {
    const loaded = loadShells(serverId);
    // Respect prior state INCLUDING an explicitly-emptied panel (loaded but
    // zero shells) — we only seed a starter shell on a truly fresh visit
    // (no stored state at all).
    if (loaded) {
      counterRef.current = Math.max(loaded.counter, loaded.shells.length, 1);
      return loaded.shells;
    }
    return [{ id: genId(), label: interpolate(m.shell, { n: "1" }), resumeToken: null }];
  });
  const [activeId, setActiveId] = useState<string>(() => shells[0]?.id ?? "");

  // Persist whenever the list changes. Saving full {id,label,resumeToken}
  // so on next page load we can attempt resume per shell.
  useEffect(() => {
    saveShells(serverId, shells, counterRef.current);
  }, [serverId, shells]);

  const atMax = shells.length >= maxShells;

  const handleAdd = useCallback(() => {
    if (atMax) return;
    counterRef.current += 1;
    const next: ShellEntry = {
      id: genId(),
      label: interpolate(m.shell, { n: String(counterRef.current) }),
      resumeToken: null,
    };
    setShells((prev) => [...prev, next]);
    setActiveId(next.id);
  }, [atMax, m]);

  /**
   * Per-shell resume token updater. Wired into every <ServerTerminal>
   * via onResumeTokenChange. A non-null token means the server just
   * gave us a fresh resume handle (on `ready` frame); null means the
   * shell exited cleanly or a resume failed and we should drop the
   * stored token before the next reconnect.
   */
  const handleResumeTokenChange = useCallback((id: string, token: string | null) => {
    setShells((prev) => {
      let changed = false;
      const next = prev.map((s) => {
        if (s.id !== id) return s;
        if (s.resumeToken === token) return s;
        changed = true;
        return { ...s, resumeToken: token };
      });
      return changed ? next : prev;
    });
  }, []);

  // One ref per shell so we can call .terminate() explicitly when the
  // user clicks X. Default WS close (unmount, navigate away) parks the
  // session; only explicit X clicks terminate. The Map keys mirror
  // shell.id so refs survive shell reorderings.
  const shellHandles = useRef<Map<string, ServerTerminalHandle | null>>(new Map());

  const handleClose = useCallback((id: string) => {
    // Tell the server "really close this one" before removing it from
    // the UI. The handle's terminate() sends the close control frame +
    // tears down the WS, which makes the server skip the park branch
    // and finalize the audit row.
    shellHandles.current.get(id)?.terminate();
    shellHandles.current.delete(id);
    setShells((prev) => {
      const idx = prev.findIndex((s) => s.id === id);
      if (idx < 0) return prev;
      return prev.filter((s) => s.id !== id);
    });
    setActiveId((current) => {
      if (current !== id) return current;
      const remaining = shells.filter((s) => s.id !== id);
      if (remaining.length === 0) return "";
      const idx = shells.findIndex((s) => s.id === id);
      return remaining[Math.max(0, idx - 1)]?.id ?? remaining[0].id;
    });
  }, [shells]);

  return (
    <div className={`flex h-full w-full flex-col ${className}`}>
      {/* ── Tab strip ────────────────────────────────────────────────── */}
      <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/20 px-2.5 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {shells.map((shell) => {
            const isActive = shell.id === activeId;
            return (
              <div
                key={shell.id}
                className={
                  "group inline-flex shrink-0 items-center gap-1.5 rounded-lg py-1.5 ps-2.5 pe-1.5 text-[12px] transition-colors " +
                  (isActive
                    ? "bg-card text-foreground shadow-sm ring-1 ring-border/60"
                    : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground")
                }
              >
                <button
                  type="button"
                  onClick={() => setActiveId(shell.id)}
                  className="inline-flex items-center gap-1.5 font-medium"
                >
                  <span
                    className={
                      "size-1.5 rounded-full transition-colors " +
                      (isActive ? "bg-success-solid" : "bg-muted-foreground/40")
                    }
                  />
                  {shell.label}
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClose(shell.id);
                  }}
                  aria-label={interpolate(m.close, { label: shell.label })}
                  className={
                    "rounded-md p-0.5 text-muted-foreground transition-all hover:bg-foreground/10 hover:text-foreground " +
                    (isActive
                      ? "opacity-70 hover:opacity-100"
                      : "opacity-0 group-hover:opacity-70")
                  }
                >
                  <X className="size-3" />
                </button>
              </div>
            );
          })}
        </div>
        <button
          type="button"
          onClick={handleAdd}
          disabled={atMax}
          title={atMax ? interpolate(m.serverLimit, { max: String(maxShells) }) : m.newShell}
          className={
            "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors " +
            (atMax
              ? "cursor-not-allowed text-muted-foreground/40"
              : "text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground")
          }
        >
          <Plus className="size-3.5" />
          {m.newShell}
        </button>
      </div>

      {/* ── Shells ──────────────────────────────────────────────────────
          All mounted, only one visible. The hidden ones keep their WS
          open so output keeps flowing into scrollback. */}
      <div className="relative min-h-0 flex-1">
        {shells.length === 0 && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">{m.noTerminals}</p>
            <button
              type="button"
              onClick={handleAdd}
              className="inline-flex items-center gap-1.5 rounded-xl border border-border/50 bg-muted/30 px-4 py-2 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60"
            >
              <Plus className="size-3.5" />
              {m.newShell}
            </button>
          </div>
        )}
        {shells.map((shell) => {
          const isActive = shell.id === activeId;
          return (
            <div
              key={shell.id}
              className={isActive ? "absolute inset-0" : "hidden"}
            >
              <ServerTerminal
                ref={(handle) => {
                  if (handle) shellHandles.current.set(shell.id, handle);
                  else shellHandles.current.delete(shell.id);
                }}
                serverId={serverId}
                enabled={enabled}
                visible={isActive}
                theme={resolvedTheme === "light" ? "light" : "dark"}
                resumeToken={shell.resumeToken}
                onResumeTokenChange={(token) =>
                  handleResumeTokenChange(shell.id, token)
                }
                className="h-full"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default ServerTerminalTabs;
