"use client";

import { useCallback, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { PageContainer } from "@/components/ui/PageContainer";
import {
  BillingLink,
  BillingWorkspaceProvider,
} from "@/components/billing/BillingWorkspaceContext";
import {
  BillingServerInventoryProvider,
  ServerBillingPicker,
  billingServersVisible,
} from "@/components/billing/ServerBillingPicker";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Icon } from "@repo/ui/icons";
import { useServerDestinations } from "@/hooks/useServerDestinations";
import { CloudPurchaseProvider } from "@/components/billing/CloudPurchaseContext";
import { newServerBillingHref } from "@/lib/billing-links";
import { BILLING_TABS } from "./billing-tabs";
import { BillingTabBar } from "./BillingTabBar";
import { BillingHeader } from "./BillingHeader";
import Link from "next/link";
import { BillingViewProvider, type BillingView } from "./BillingViewContext";
import { PendingCheckoutsProvider } from "@/components/billing/PendingCheckoutsContext";
import { BillingPurchaseContent } from "./BillingPurchaseContent";

/** Persistent route chrome. Only the tab content suspends while its scoped state loads. */
export function BillingLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname.endsWith("/manage"))
    return (
      <PageContainer className="space-y-6">
        <BillingHeader>
          <Button asChild variant="secondary">
            <Link href="/billing/plans">
              <Icon name="arrow-left" className="size-4 rtl:rotate-180" />
              Back to plans
            </Link>
          </Button>
        </BillingHeader>
        {children}
      </PageContainer>
    );
  return <CloudBillingLayout>{children}</CloudBillingLayout>;
}
function CloudBillingLayout({ children }: { children: React.ReactNode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedWorkspaceId = searchParams.get("workspaceId") || undefined;
  const organizationId = searchParams.get("organizationId") || undefined;
  const segment = pathname.split("/").at(-1);
  const newServer =
    segment === "plans" &&
    searchParams.get("newServer") === "1" &&
    !["checkout", "topup", "session_id"].some((key) => searchParams.has(key));
  const inventory = useServerDestinations();
  const [view, setView] = useState<BillingView | null>(null);
  const organizationMatches = !organizationId || organizationId === inventory.organizationId;
  const currentView =
    view?.contextKey === inventory.contextKey &&
    organizationMatches &&
    Boolean(view.newServer) === newServer
      ? view
      : null;
  // Keep navigation mounted during a server switch, without reusing the
  // previous server's purchase mode or billing scope while the next one loads.
  const scopedView =
    currentView?.requestedWorkspaceId === requestedWorkspaceId ? currentView : null;
  const workspaceId = newServer ? undefined : (requestedWorkspaceId ?? scopedView?.workspaceId);
  const reportView = useCallback(
    (next: BillingView) => {
      // A tab from an earlier account, organization or server cannot update the
      // current navigation while its replacement is still loading.
      if (
        next.contextKey === inventory.contextKey &&
        next.organizationId === organizationId &&
        next.requestedWorkspaceId === requestedWorkspaceId &&
        Boolean(next.newServer) === newServer
      )
        setView(next);
    },
    [inventory.contextKey, organizationId, requestedWorkspaceId, newServer],
  );

  const servers = inventory.data?.servers.filter((server) => server.managed) ?? [];
  const plansOnly =
    newServer ||
    (Boolean(scopedView?.plansOnly) && segment !== "payment" && segment !== "invoices");
  const activeTab = plansOnly
    ? "plans"
    : segment === "invoices"
      ? "payment"
      : (BILLING_TABS.find((tab) => tab.key === segment)?.key ?? "overview");
  const serverInventory = organizationMatches
    ? {
        servers,
        loading: inventory.loading,
        error: inventory.error,
        onRetry: inventory.refresh,
      }
    : null;

  return (
    <PageContainer className="space-y-6">
      <BillingWorkspaceProvider workspaceId={workspaceId} organizationId={organizationId}>
        <BillingViewProvider value={reportView}>
          <BillingServerInventoryProvider value={serverInventory}>
            <PendingCheckoutsProvider
              enabled={organizationMatches && (servers.length > 0 || Boolean(workspaceId))}
            >
              <CloudPurchaseProvider
                scopeKey={`${inventory.resourceKey}:${organizationId ?? ""}:${newServer ? "new" : (workspaceId ?? "unsubscribed")}`}
                tabs={plansOnly ? "header" : activeTab === "plans" ? "inline" : "none"}
                management={activeTab === "plans" && organizationMatches}
              >
                <BillingHeader>
                  {billingServersVisible(serverInventory) &&
                    (newServer ? (
                      <Button asChild variant="secondary" className="shrink-0">
                        <BillingLink href="/billing">
                          <Icon name="arrow-left" className="size-4 rtl:rotate-180" />
                          {t.billing.creditAlert.backToBilling}
                        </BillingLink>
                      </Button>
                    ) : (
                      <div className="flex w-full min-w-0 flex-wrap items-center gap-3 sm:w-auto">
                        {activeTab === "plans" && <div className="w-full min-w-0 md:w-auto"><ServerBillingPicker compact /></div>}
                        <Button asChild variant="secondary" className="shrink-0">
                          <BillingLink href={newServerBillingHref()}>
                            <Icon name="plus" className="size-4" aria-hidden="true" />
                            {t.billing.layout.getServer}
                          </BillingLink>
                        </Button>
                      </div>
                    ))}
                </BillingHeader>
                <BillingTabBar
                  activeTab={activeTab}
                  plansOnly={plansOnly}
                  topupsAvailable={scopedView?.topupsAvailable}
                  loading={!currentView}
                />
                <BillingPurchaseContent>{children}</BillingPurchaseContent>
              </CloudPurchaseProvider>
            </PendingCheckoutsProvider>
          </BillingServerInventoryProvider>
        </BillingViewProvider>
      </BillingWorkspaceProvider>
    </PageContainer>
  );
}
