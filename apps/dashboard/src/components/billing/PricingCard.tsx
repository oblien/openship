import type { ReactNode } from "react";

// Keep a lone offer at card width. Larger comparisons, including in the deploy
// modal, use balanced rows until there is room for four readable cards.
const CARD_COLUMNS: Record<number, string> = {
  1: "grid-cols-1 max-w-[26rem]",
  2: "grid-cols-1 @min-[34rem]/pricing:grid-cols-2",
  3: "grid-cols-1 @min-[34rem]/pricing:grid-cols-2 @min-[52rem]/pricing:grid-cols-3",
  4: "grid-cols-1 @min-[34rem]/pricing:grid-cols-2 @min-[70rem]/pricing:grid-cols-4",
};

export function PricingCardGrid({ count, children }: { count: number; children: ReactNode }) {
  return <div className={`grid gap-4 ${CARD_COLUMNS[Math.min(count, 4)] ?? ""}`}>{children}</div>;
}

export function PricingCard({
  id,
  name,
  icon,
  popularLabel,
  selected,
  children,
}: {
  id?: string;
  name: string;
  icon: ReactNode;
  popularLabel?: string;
  selected?: boolean;
  children: ReactNode;
}) {
  return (
    <article
      id={id}
      aria-label={name}
      aria-current={selected || undefined}
      className={`relative min-w-0 scroll-mt-6 rounded-2xl bg-card p-5 aria-[current=true]:ring-1 aria-[current=true]:ring-primary ${popularLabel ? "bg-gradient-to-b from-primary/5 to-card" : ""}`}
    >
      <div className="mb-4 flex min-h-10 flex-wrap items-center gap-3">
        <div
          className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${popularLabel ? "bg-primary/10 text-primary" : "bg-muted/60 text-foreground/80"}`}
        >
          {icon}
        </div>
        <h3 className="text-lg font-semibold tracking-tight text-foreground">{name}</h3>
        {popularLabel && (
          <span className="ms-auto rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground">
            {popularLabel}
          </span>
        )}
      </div>
      {children}
    </article>
  );
}
