"use client";

import type { ReactNode } from "react";
import { PageContainer } from "@/components/ui/PageContainer";
import { useI18n } from "@/components/i18n-provider";
import { BillingSupportLink } from "./BillingSupportLink";

export function ManagementPlanLayout({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  return (
    <PageContainer className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium">Openship Manage</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t.billing.managementPlans.description}
          </p>
        </div>
        <BillingSupportLink />
      </header>
      {children}
    </PageContainer>
  );
}
