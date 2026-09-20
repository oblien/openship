"use client";

import { useI18n } from "@/components/i18n-provider";

export function BillingHeader() {
  const { t } = useI18n();
  return (
    <header>
      <h1 className="text-2xl font-medium tracking-tight text-foreground/80">{t.billing.layout.title}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{t.billing.layout.subtitle}</p>
    </header>
  );
}
