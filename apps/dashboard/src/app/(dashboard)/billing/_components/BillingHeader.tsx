"use client";

import { useI18n } from "@/components/i18n-provider";
import { useOptionalCloudPurchase } from "@/components/billing/CloudPurchaseContext";

export function BillingHeader({ children }: { children?: React.ReactNode }) {
  const { t } = useI18n();
  const purchase = useOptionalCloudPurchase();
  const buyingServer = purchase?.tabs === "header";
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div className="min-w-0 flex-1 basis-96">
        <h1 className="text-2xl font-medium tracking-tight text-foreground/80">
          {buyingServer ? purchase.intro.title : t.billing.layout.title}
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          {buyingServer ? purchase.intro.description : t.billing.layout.subtitle}
        </p>
      </div>
      <div className="ms-auto flex w-full min-w-0 flex-wrap items-center justify-end gap-3 empty:hidden sm:w-auto">
        {buyingServer && (
          <fieldset
            ref={purchase.setControlsTarget}
            disabled={purchase.busy}
            aria-busy={purchase.busy}
            hidden={purchase.mode !== "monthly"}
            className="min-w-0 empty:hidden"
          />
        )}
        {buyingServer && <div ref={purchase.setDetailsTarget} hidden={purchase.mode === "manage"} className="empty:hidden" />}
        {purchase?.mode !== "manage" && children}
      </div>
    </header>
  );
}
