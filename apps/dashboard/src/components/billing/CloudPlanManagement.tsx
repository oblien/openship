"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { CloudAllocation } from "@repo/core";
import type { CloudWorkspaceSummary } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Tabs, type TabDef } from "@/components/ui/Tabs";
import { PlanChangeModal } from "./PlanChangeModal";
import { CapacitySummary } from "@/components/shared/CapacitySummary";
import { useScopedResource } from "@/hooks/use-scoped-resource";
import { billingApi, type BillingState } from "@/lib/api/billing";
import {
  BillingPlanSummary,
  BillingPaymentsPanel,
} from "@/app/(dashboard)/billing/_components/billing-shared";
import { BillingCheckoutStatus } from "@/app/(dashboard)/billing/_components/BillingCheckoutStatus";
import { BillingWorkspaceProvider } from "./BillingWorkspaceContext";
import { BillingSubscriptionControls } from "./BillingSubscriptionControls";
import { BillingOverview } from "./BillingOverview";
import { BillingUsage } from "./BillingUsage";
import { BillingTopups } from "./BillingTopups";
import { PendingCheckoutsProvider, usePendingCheckouts } from "./PendingCheckoutsContext";
import {
  isMonthlyCloudPlan,
  isNewCloudCustomer,
  subscriptionNeedsPayment,
} from "@/lib/billing-presentation";
import { cloudSpaceHref, type CloudPlanTab } from "@/lib/cloud-spaces";
import { CloudPlanPicker } from "./CloudPlanPicker";

type PlanProps = {
  workspaceId: string;
  serverId: string;
  server: CloudWorkspaceSummary;
  resources?: CloudAllocation | null;
  refreshKey?: number;
  onUpdated: () => void;
  header: (planName?: string) => ReactNode;
  children: ReactNode;
};

/** One scoped read and recovery list for every tab of this purchased plan. */
export function CloudPlanManagement(props: PlanProps) {
  const query = useSearchParams();
  return (
    <BillingWorkspaceProvider
      workspaceId={props.workspaceId}
      organizationId={query.get("organizationId") || undefined}
    >
      <PendingCheckoutsProvider workspaceId={props.workspaceId}>
        <PlanContent {...props} />
      </PendingCheckoutsProvider>
    </BillingWorkspaceProvider>
  );
}

function PlanContent({
  workspaceId,
  serverId,
  server,
  resources,
  refreshKey,
  onUpdated,
  header,
  children,
}: PlanProps) {
  const { t, locale } = useI18n();
  const query = useSearchParams();
  const router = useRouter();
  const pending = usePendingCheckouts()!;
  const [changing, setChanging] = useState(query.get("changePlan") === "1");
  const changeRequested = query.get("changePlan") === "1";
  useEffect(() => {
    if (changeRequested) setChanging(true);
  }, [changeRequested]);
  const load = useCallback(async () => {
    const state = await billingApi.getBillingState(workspaceId);
    if (state.workspace?.id !== workspaceId)
      throw new Error("Billing data did not match this plan. Please retry.");
    return state;
  }, [workspaceId, refreshKey]);
  const billing = useScopedResource(load, 60_000);
  const state = billing.data;
  const pendingPurchase =
    pending.count > 0 ? pending.items.find((item) => item.kind === "subscription") : undefined;
  const topups = Boolean(state && !isMonthlyCloudPlan(state) && state.topups?.available);
  const requested = query.get("tab");
  const tab: CloudPlanTab =
    requested === "usage" || requested === "payment" || requested === "activity"
      ? requested
      : requested === "topups" && topups
        ? "topups"
        : "overview";
  const href = (value: CloudPlanTab) =>
    cloudSpaceHref(serverId, value, new URLSearchParams(query.toString()));
  const refresh = () => {
    billing.refresh();
    void pending.refresh();
    onUpdated();
  };
  const closeChange = () => {
    setChanging(false);
    if (changeRequested) {
      const params = new URLSearchParams(query.toString());
      params.delete("changePlan");
      router.replace(cloudSpaceHref(serverId, tab, params), { scroll: false });
    }
  };
  const tabs: TabDef<CloudPlanTab>[] = [
    { key: "overview", label: t.billing.tabs.overview, icon: "dashboard" },
    { key: "usage", label: t.billing.tabs.usage, icon: "chart-bar" },
    {
      key: "payment",
      label: t.billing.tabs.payment,
      icon: "credit-card",
      count: pending.count || undefined,
    },
    { key: "activity", label: t.servers.detail.tabs.activity, icon: "clock" },
    { key: "topups", label: t.billing.tabs.topups, icon: "coins", hidden: !topups },
  ];
  const returned = query.get("checkout") === "success" || query.get("topup") === "success";
  return (
    <div className="space-y-5">
      {header(
        state?.plan?.name ?? (server.planTierId === "free" ? pendingPurchase?.name : undefined),
      )}
      <Tabs
        tabs={tabs.map((item) => ({ ...item, href: href(item.key) }))}
        value={tab}
        onChange={(value) => router.replace(href(value), { scroll: false })}
        ariaLabel={t.billing.layout.title}
      />
      {returned && (
        <BillingCheckoutStatus
          onResolved={refresh}
          kind={query.get("topup") === "success" ? "topup" : "subscription"}
          checkoutId={query.get("session_id") || undefined}
          expectedTier={query.get("tier") || undefined}
          expectedOffer={query.get("offer") || undefined}
          expectedInterval={
            query.get("interval") === "annual"
              ? "annual"
              : query.get("interval") === "monthly"
                ? "monthly"
                : undefined
          }
        />
      )}
      {(pending.count > 0 ||
        subscriptionNeedsPayment(state?.subscription?.status ?? state?.status)) && (
        <section
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-danger/10 p-4 text-sm text-danger"
        >
          <div>
            <p className="font-medium">{t.billing.hub.paymentRequired}</p>
            <p className="mt-1">{t.billing.hub.paymentNotice}</p>
          </div>
          {tab !== "payment" && (
            <Button asChild variant="secondary" size="sm">
              <Link href={href("payment")}>{t.billing.hub.reviewPayment}</Link>
            </Button>
          )}
        </section>
      )}
      {billing.error && (
        <section
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-danger/10 p-4 text-sm text-danger"
        >
          <p>{billing.error}</p>
          <Button variant="secondary" size="sm" onClick={billing.refresh}>
            {t.billing.plansRoute.tryAgain}
          </Button>
        </section>
      )}
      <div className="grid items-start gap-5 @min-[64rem]/resources:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-5">
          {(tab === "overview" || tab === "usage" || tab === "activity") && children}
          {state ? (
            <>
              {tab === "overview" && (
                <BillingOverview state={state} embedded server={server} onUpdated={refresh} />
              )}
              {tab === "usage" && <BillingUsage state={state} />}
              {tab === "topups" && <BillingTopups state={state} />}
            </>
          ) : tab !== "overview" && tab !== "activity" && billing.loading ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t.billing.workspaces.loading}
            </p>
          ) : null}
          {tab === "payment" && (
            <BillingPaymentsPanel
              workspaceId={workspaceId}
              portalAvailable={state?.capabilities?.portal === true}
              hasHistory={Boolean(state && !isNewCloudCustomer(state))}
            >
              {state?.subscription && (
                <BillingSubscriptionControls
                  state={state}
                  allowCancellation={false}
                  onUpdated={refresh}
                />
              )}
            </BillingPaymentsPanel>
          )}
        </div>
        <aside className="min-w-0 space-y-4">
          {state ? (
            <>
              {pendingPurchase && isNewCloudCustomer(state) ? (
                <section className="space-y-3 rounded-2xl bg-card p-5">
                  <p className="text-xs text-danger">{t.billing.hub.paymentPending}</p>
                  <h2 className="text-lg font-medium">{pendingPurchase.name}</h2>
                  <p className="text-xl font-medium">
                    {new Intl.NumberFormat(locale, {
                      style: "currency",
                      currency: pendingPurchase.currency,
                    }).format(pendingPurchase.amountCents / 100)}
                  </p>
                </section>
              ) : (
                <BillingPlanSummary state={state} allocatedResources={resources} />
              )}
              {pending.count === 0 && (
                <Button className="w-full" onClick={() => setChanging(true)}>
                  {t.billing.workspaces.changePlan}
                  <Icon name="arrow-up-right" className="size-4" aria-hidden="true" />
                </Button>
              )}
              {changing && (
                <PlanChangeDialog
                  state={state}
                  allocatedDiskGb={resources ? resources.diskMb / 1024 : undefined}
                  onClose={closeChange}
                  onAccepted={() => {
                    closeChange();
                    refresh();
                  }}
                />
              )}
            </>
          ) : (
            <section className="space-y-4 rounded-2xl bg-card p-5" aria-busy={billing.loading}>
              <h2 className="text-base font-medium">{t.servers.resources.capacity}</h2>
              {resources && <CapacitySummary resources={resources} />}
              {billing.loading && (
                <p role="status" className="text-sm text-muted-foreground">
                  {t.billing.workspaces.loading}
                </p>
              )}
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function PlanChangeDialog({
  state,
  allocatedDiskGb,
  onClose,
  onAccepted,
}: {
  state: BillingState;
  allocatedDiskGb?: number;
  onClose: () => void;
  onAccepted: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [planCount, setPlanCount] = useState<number | null>(null);
  const width =
    planCount === 1
      ? 480
      : planCount === 3
        ? 1280
        : planCount !== null && planCount > 3
          ? 1480
          : 920;
  return (
    <PlanChangeModal busy={busy} width={width} onClose={onClose}>
      <div className="min-w-0">
        <CloudPlanPicker
          preserveProject
          workspaceId={state.workspace!.id}
          currentPlan={state.tier}
          currentOffer={state.plan}
          allocatedDiskGb={allocatedDiskGb ?? state.capacity?.diskGb?.used}
          subscription={state.subscription}
          complimentary={state.complimentary}
          billingEnabled={state.billing?.enabled === true}
          canChangeSubscription={state.capabilities?.subscriptionChange === true}
          onBusyChange={setBusy}
          onVisiblePlanCountChange={setPlanCount}
          onCheckoutStarted={onAccepted}
        />
      </div>
    </PlanChangeModal>
  );
}
