"use client";

/** Compact Runtime + Code → live site. Not a diagram dump. */
export function ReleaseSpine({
  hostname,
  codeLabel,
  runtimeLabel,
}: {
  hostname: string;
  codeLabel: string;
  runtimeLabel: string;
}) {
  return (
    <div className="border-b border-border/40 px-5 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <SpineNode label="Runtime" value={runtimeLabel} />
          <SpineNode label="Code" value={codeLabel} />
        </div>
        <svg
          viewBox="0 0 48 56"
          className="h-14 w-12 shrink-0 text-border"
          aria-hidden
        >
          <path
            d="M4 12 H22 C30 12 30 28 38 28"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M4 44 H22 C30 44 30 28 38 28"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <circle cx="4" cy="12" r="2.5" className="fill-muted-foreground" />
          <circle cx="4" cy="44" r="2.5" className="fill-emerald-500" />
          <circle cx="42" cy="28" r="3" className="fill-primary" />
        </svg>
        <div className="min-w-0 max-w-[11rem] rounded-xl border border-border/50 bg-muted/20 px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
            Live
          </p>
          <p className="truncate text-[12px] font-medium text-foreground" title={hostname}>
            {hostname}
          </p>
        </div>
      </div>
    </div>
  );
}

function SpineNode({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/40 bg-background px-2.5 py-1.5">
      <span className="shrink-0 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </span>
      <span className="truncate font-mono text-[11px] text-foreground">{value}</span>
    </div>
  );
}
