"use client";

import { useCallback, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { PageContainer } from "@/components/ui/PageContainer";
import { BillingWorkspaceProvider } from "@/components/billing/BillingWorkspaceContext";
import { BillingServerInventoryProvider } from "@/components/billing/ServerBillingPicker";
import { useServerDestinations } from "@/hooks/useServerDestinations";
import { usePlatform } from "@/context/PlatformContext";
import { BILLING_TABS } from "./billing-tabs";
import { BillingTabBar } from "./BillingTabBar";
import { BillingHeader } from "./BillingHeader";
import { BillingViewProvider, type BillingView } from "./BillingViewContext";

/** Persistent route chrome. Only the tab content suspends while its scoped state loads. */
export function BillingLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requestedWorkspaceId = searchParams.get("workspaceId") || undefined;
  const organizationId = searchParams.get("organizationId") || undefined;
  const { selfHosted } = usePlatform();
  const inventory = useServerDestinations(!selfHosted);
  const [view, setView] = useState<BillingView | null>(null);
  const organizationMatches = !organizationId || organizationId === inventory.organizationId;
  const currentView = view?.contextKey === inventory.contextKey && organizationMatches ? view : null;
  const workspaceId = requestedWorkspaceId ?? (
    currentView?.requestedWorkspaceId === requestedWorkspaceId ? currentView?.workspaceId : undefined
  );
  const reportView = useCallback((next: BillingView) => {
    // A tab from an earlier account, organization or server cannot update the
    // current navigation while its replacement is still loading.
    if (next.contextKey === inventory.contextKey && next.organizationId === organizationId
      && next.requestedWorkspaceId === requestedWorkspaceId) setView(next);
  }, [inventory.contextKey, organizationId, requestedWorkspaceId]);

  const servers = inventory.data?.servers.filter(server => server.managed) ?? [];
  const segment = pathname.split("/").at(-1);
  const activeTab = currentView?.plansOnly ? "plans" : BILLING_TABS.find((tab) => tab.key === segment)?.key ?? "overview";

  return (
    <PageContainer className="space-y-6">
      <BillingWorkspaceProvider workspaceId={workspaceId} organizationId={organizationId}>
        <BillingViewProvider value={reportView}>
          <BillingHeader />
          <BillingTabBar activeTab={activeTab} plansOnly={currentView?.plansOnly} loading={!currentView} />
          <BillingServerInventoryProvider value={!selfHosted && organizationMatches ? {
            servers, loading: inventory.loading, error: inventory.error, onRetry: inventory.refresh,
          } : null}>
            {children}
          </BillingServerInventoryProvider>
        </BillingViewProvider>
      </BillingWorkspaceProvider>
    </PageContainer>
  );
}
