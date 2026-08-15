"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Loader2, Plus, Trash2, UserRound } from "lucide-react";
import { DismissiblePopover } from "@/components/ui/Popover";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function DesktopProfileMenu({ collapsed }: { collapsed: boolean }) {
  const bridge = typeof window !== "undefined" ? window.desktop?.profiles : undefined;
  const [state, setState] = useState<DesktopProfilesState | null>(null);
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    void bridge
      .list()
      .then(setState)
      .catch(() => setError("Profiles could not be loaded."));
  }, [bridge]);

  const active = useMemo(
    () => state?.profiles.find((profile) => profile.id === state.activeProfileId) ?? null,
    [state],
  );

  if (!bridge || !state || !active) return null;

  async function createProfile() {
    const nextName = name.trim();
    if (!nextName) return;
    setBusy("create");
    setError(null);
    try {
      const profile = await bridge!.create(nextName);
      await bridge!.switch(profile.id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Profile could not be created.");
      setBusy(null);
    }
  }

  async function removeProfile(profile: DesktopProfile) {
    setBusy(profile.id);
    setError(null);
    try {
      await bridge!.remove(profile.id);
      setState(await bridge!.list());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Profile could not be removed.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <DismissiblePopover open={open} onOpenChange={setOpen} className="relative mb-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={`group flex w-full items-center rounded-xl px-2 py-2 text-start transition-colors hover:bg-foreground/[0.06] ${collapsed ? "justify-center" : "gap-3"}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={collapsed ? active.name : undefined}
      >
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border/70 bg-background text-foreground">
          <UserRound className="size-4" />
        </div>
        {!collapsed && (
          <>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold leading-tight text-foreground">
                {active.name}
              </p>
              <p className="truncate text-[11px] leading-tight text-muted-foreground">
                Desktop profile
              </p>
            </div>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
          </>
        )}
      </button>

      {open && (
        <div
          className={`absolute z-50 overflow-hidden rounded-2xl border border-border/50 bg-popover shadow-xl shadow-black/[0.08] ${collapsed ? "start-full bottom-0 ms-2 w-72" : "start-0 end-0 bottom-full mb-2"}`}
        >
          <div className="px-3 pb-2 pt-3">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/70">
              Desktop profiles
            </p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Sessions stay separate. Projects and servers stay shared.
            </p>
          </div>

          <div className="max-h-56 overflow-y-auto pb-1">
            {state.profiles.map((profile) => {
              const isCurrent = profile.id === state.activeProfileId;
              return (
                <div
                  key={profile.id}
                  className={`flex items-center gap-1 px-2 ${isCurrent ? "bg-foreground/[0.03]" : ""}`}
                >
                  <button
                    type="button"
                    disabled={!!busy || isCurrent}
                    onClick={() => {
                      setBusy(profile.id);
                      void bridge.switch(profile.id);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-xl px-1 py-2 text-start hover:bg-foreground/[0.05] disabled:opacity-70"
                  >
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border/60 bg-background text-[11px] font-semibold uppercase">
                      {profile.name[0]}
                    </div>
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                      {profile.name}
                    </span>
                    {isCurrent && <Check className="size-4 shrink-0 text-primary" />}
                    {busy === profile.id && (
                      <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                    )}
                  </button>
                  {!isCurrent && (
                    <button
                      type="button"
                      disabled={!!busy}
                      onClick={() => void removeProfile(profile)}
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      aria-label={`Remove ${profile.name}`}
                      title={`Remove ${profile.name}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="border-t border-border/40 p-2">
            {adding ? (
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void createProfile();
                }}
              >
                <Input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Main_Backup"
                  maxLength={40}
                  autoFocus
                />
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={!!busy}
                    onClick={() => setAdding(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={!!busy || !name.trim()}>
                    {busy === "create" && <Loader2 className="size-3.5 animate-spin" />}
                    Add profile
                  </Button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setAdding(true);
                  setError(null);
                }}
                className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-[13px] font-medium text-foreground hover:bg-foreground/[0.05]"
              >
                <Plus className="size-4 text-muted-foreground" />
                Add profile
              </button>
            )}

            {error && (
              <p className="px-2 pb-1 pt-2 text-xs leading-relaxed text-destructive">{error}</p>
            )}

            <button
              type="button"
              onClick={() => void bridge.signOut()}
              className="mt-1 w-full rounded-xl px-2 py-2 text-start text-[12px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
            >
              Sign out of {active.name}
            </button>
          </div>
        </div>
      )}
    </DismissiblePopover>
  );
}
