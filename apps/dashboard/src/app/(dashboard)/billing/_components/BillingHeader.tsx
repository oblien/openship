"use client";

import { useI18n } from "@/components/i18n-provider";

export function BillingHeader({ children }: { children?: React.ReactNode }) {
  const { t } = useI18n();
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-2xl font-medium tracking-tight text-foreground/80">
          {t.billing.layout.title}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">{t.billing.layout.subtitle}</p>
      </div>
      {children}
    </header>
  );
}
