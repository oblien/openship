"use client";

import { useCallback, useState } from "react";
import type { CloudAllocation } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { PlanChangeModal } from "./PlanChangeModal";
import { CapacitySummary } from "@/components/shared/CapacitySummary";
import { useScopedResource } from "@/hooks/use-scoped-resource";
import { billingApi, type BillingState } from "@/lib/api/billing";
import { BillingPlanSummary } from "@/app/(dashboard)/billing/_components/billing-shared";
import { BillingWorkspaceProvider } from "./BillingWorkspaceContext";
import { BillingSubscriptionControls } from "./BillingSubscriptionControls";
import { BillingComputeCoverage } from "./BillingComputeCoverage";
import { CloudPlanPicker } from "./CloudPlanPicker";

/** The same scoped billing contract and actions as Billing, beside this plan's projects. */
export function CloudPlanManagement({
  workspaceId,
  resources,
  refreshKey,
  onUpdated,
}: {
  workspaceId: string;
  resources?: CloudAllocation | null;
  refreshKey?: number;
  onUpdated: () => void;
}) {
  const { t } = useI18n();
  const [changing, setChanging] = useState(false);
  const load = useCallback(async () => {
    const state = await billingApi.getBillingState(workspaceId);
    // Never attach another subscription's prices or actions to this plan.
    if (state.workspace?.id !== workspaceId)
      throw new Error("Billing data did not match this plan. Please retry.");
    return state;
  }, [workspaceId, refreshKey]);
  const billing = useScopedResource(load, 60_000);
  const state = billing.data;
  const refresh = onUpdated;
  return (
    <BillingWorkspaceProvider workspaceId={workspaceId}>
      <div className="space-y-4">
        {billing.error && (
          <section role="alert" className="space-y-3 rounded-2xl bg-card p-5 text-sm">
            <p className="text-danger">{billing.error}</p>
            <Button variant="secondary" size="sm" onClick={billing.refresh}>
              {t.billing.plansRoute.tryAgain}
            </Button>
          </section>
        )}
        {state ? (
          <>
            <BillingPlanSummary state={state} allocatedResources={resources} />
            <Button className="w-full" onClick={() => setChanging(true)}>
              {t.billing.workspaces.changePlan}
              <Icon name="arrow-up-right" className="size-4" aria-hidden="true" />
            </Button>
            <div className="min-w-0">
              <BillingSubscriptionControls
                state={state}
                allowCancellation={false}
                onUpdated={refresh}
              />
            </div>
            <BillingComputeCoverage state={state} />
            {changing && (
              <PlanChangeDialog
                state={state}
                allocatedDiskGb={resources ? resources.diskMb / 1024 : undefined}
                onClose={() => setChanging(false)}
                onAccepted={() => {
                  setChanging(false);
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
      </div>
    </BillingWorkspaceProvider>
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
