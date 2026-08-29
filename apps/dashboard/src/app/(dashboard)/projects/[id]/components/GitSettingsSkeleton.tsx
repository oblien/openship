"use client";

/**
 * The Source tab while it loads.
 *
 * Same construction as every other tab's skeleton (ServicesTab, the resources card):
 * a `bg-card` SHELL with solid `bg-muted` blocks inside it.
 *
 * This used to be a transparent outline holding translucent `bg-muted/30` slivers, with
 * a comment defending it as "not a solid full-card fill". It read as a wireframe rather
 * than as the app: the shell didn't match the card that replaces it, the nested rows
 * were bare borders where the real ones are filled panels, and at /30 the blocks were
 * nearly invisible on a dark surface. Skeletons should look like the content arriving,
 * which means the same surfaces at the same sizes.
 *
 * Shape still mirrors the loaded card (header → repository row + auto-deploy toggle →
 * rollback pair → recent commits) so nothing reflows when data lands.
 */

export function GitSettingsSkeleton() {
  return (
    <div className="animate-pulse space-y-4 rounded-2xl border border-border/50 bg-card p-5">
      {/* header (icon + title + subtitle) */}
      <div className="flex items-center gap-3">
        <div className="h-9 w-9 shrink-0 rounded-xl bg-muted" />
        <div className="min-w-0 flex-1 space-y-2">
          <div className="h-3.5 w-40 rounded-lg bg-muted" />
          <div className="h-3 w-64 max-w-full rounded-lg bg-muted/60" />
        </div>
      </div>
      {/* repository row + inline auto-deploy toggle — `bg-muted/20` because that is what
          the real row carries, so the fill doesn't appear only after loading */}
      <div className="flex items-center justify-between gap-4 rounded-xl border border-border/50 bg-muted/20 px-4 py-3.5">
        <div className="min-w-0 space-y-2">
          <div className="h-2.5 w-24 rounded-lg bg-muted/60" />
          <div className="h-4 w-44 rounded-lg bg-muted" />
          <div className="h-3 w-32 rounded-lg bg-muted/60" />
        </div>
        <div className="h-6 w-11 shrink-0 rounded-full bg-muted" />
      </div>
      {/* rollback strategy + history pair */}
      <div className="grid gap-3 sm:grid-cols-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="space-y-2 rounded-xl border border-border/50 bg-muted/20 p-3"
          >
            <div className="h-3 w-20 rounded-lg bg-muted" />
            <div className="h-2.5 w-28 rounded-lg bg-muted/60" />
          </div>
        ))}
      </div>
      {/* recent commits */}
      <div className="space-y-2 pt-1">
        <div className="h-3 w-28 rounded-lg bg-muted/60" />
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="flex items-center gap-3 rounded-lg border border-border/40 bg-muted/20 px-3 py-2"
          >
            <div className="h-6 w-6 shrink-0 rounded-full bg-muted" />
            <div className="h-3 w-40 max-w-full rounded-lg bg-muted/60" />
          </div>
        ))}
      </div>
    </div>
  );
}
