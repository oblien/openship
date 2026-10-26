import { notFound, redirect } from "next/navigation";
import type { PlanTierId } from "@repo/core";
import { BillingOverview } from "@/components/billing/BillingOverview";
import { BillingUsage } from "@/components/billing/BillingUsage";
import { BillingTopups } from "@/components/billing/BillingTopups";
import { BillingPlansRoute } from "../_components/BillingPlansRoute";
import { BillingCheckoutStatus } from "../_components/BillingCheckoutStatus";
import { BillingSidebar, BillingPaymentsPanel } from "../_components/billing-shared";
import { BILLING_TABS } from "../_components/billing-tabs";
import { BillingUnavailable } from "../_components/BillingUnavailable";
import { getBillingPageState, getDefaultBillingWorkspace } from "../_components/billing-state";
import { isNewCloudCustomer } from "@/lib/billing-presentation";
import { BillingContent } from "../_components/BillingContent";
import { BillingWorkspaceProvider } from "@/components/billing/BillingWorkspaceContext";
import { CloudBillingLink } from "@/components/billing/CloudBillingLink";
import { getSession } from "@/lib/server/session";
import { billingTabHref } from "@/lib/billing-links";
import { BillingPageView, type BillingView } from "../_components/BillingViewContext";
import { ManagedServerPurchase } from "@/components/servers/managed/ManagedServerPurchase";
import { isCloudPurchaseIntent } from "@/lib/cloud-purchase-intent";

export default async function BillingTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tab } = await params;
  const query = await searchParams;

  const activeTab = tab === "invoices" ? "payment" : BILLING_TABS.find((item) => item.key === tab)?.key;
  if (!activeTab) {
    notFound();
  }

  const workspaceId = (Array.isArray(query.workspaceId) ? query.workspaceId[0] : query.workspaceId) || undefined;
  const organizationId = (Array.isArray(query.organizationId) ? query.organizationId[0] : query.organizationId) || undefined;
  const checkoutReturn = ["checkout", "topup", "session_id"].some(key => query[key] !== undefined);
  const newServer = activeTab === "plans" && query.newServer === "1" && !checkoutReturn;
  const requestedPlanId = typeof query.plan === "string" ? query.plan : undefined;
  const requestedInterval = query.interval === "monthly" || query.interval === "annual" ? query.interval : undefined;
  const autoCheckout = query.startCheckout === "1" && (query.checkoutIntent === undefined || isCloudPurchaseIntent(query.checkoutIntent));
  const checkoutIntent = isCloudPurchaseIntent(query.checkoutIntent) ? query.checkoutIntent : undefined;
  const checkoutAttempt = isCloudPurchaseIntent(query.checkoutAttempt) ? query.checkoutAttempt : undefined;
  const session = await getSession();
  const view: BillingView = {
    contextKey: `${session?.user.id ?? "local"}:${session?.session.activeOrganizationId ?? ""}`,
    requestedWorkspaceId: workspaceId,
    organizationId,
    plansOnly: false,
    newServer,
  };
  if (organizationId && session?.session.activeOrganizationId !== organizationId) {
    return <BillingPageView view={view}><CloudBillingLink organizationId={organizationId} tab={activeTab} workspaceId={workspaceId} newServer={newServer}
      purchase={newServer ? { planId: requestedPlanId, interval: requestedInterval, startCheckout: autoCheckout, checkoutIntent, checkoutAttempt, referralCode: typeof query.ref === "string" ? query.ref : undefined } : undefined} embedded /></BillingPageView>;
  }
  // Buying another server is separate from inspecting an existing subscription.
  // The shared purchase component creates an explicitly scoped identity on selection.
  if (newServer) return <BillingPageView view={{ ...view, plansOnly: true }}>
    <BillingWorkspaceProvider>
      <BillingContent layout="purchase" sidebar={null}><ManagedServerPurchase
        initialReferralCode={typeof query.ref === "string" ? query.ref : undefined}
        requestedPlanId={requestedPlanId}
        requestedInterval={requestedInterval}
        autoCheckout={autoCheckout}
        checkoutIntent={checkoutIntent}
        checkoutAttempt={checkoutAttempt}
      /></BillingContent>
    </BillingWorkspaceProvider>
  </BillingPageView>;
  let result = await getBillingPageState(workspaceId);
  if (result.kind === "unavailable" && result.reason === "workspace-required" && !workspaceId && !checkoutReturn) {
    const defaultWorkspaceId = await getDefaultBillingWorkspace();
    if (defaultWorkspaceId) {
      view.workspaceId = defaultWorkspaceId;
      result = await getBillingPageState(defaultWorkspaceId);
    }
  }

  if (result.kind === "unavailable") {
    return <BillingPageView view={view}><BillingContent layout={activeTab === "plans" ? "plans" : "details"} sidebar={null}>
      <BillingUnavailable reason={result.reason} />
    </BillingContent></BillingPageView>;
  }

  const state = result.state;
  const plansOnly = isNewCloudCustomer(state);
  if (plansOnly && activeTab !== "plans" && activeTab !== "payment") {
    redirect(billingTabHref("plans", { ...query, workspaceId: state.workspace?.id ?? workspaceId }));
  }
  if (tab === "invoices") {
    redirect(billingTabHref("payment", { ...query, workspaceId: state.workspace?.id ?? workspaceId }));
  }

  function renderTab() {
    switch (tab) {
      case "overview":
        return <BillingOverview state={state} />;
      case "usage":
        return <BillingUsage state={state} />;
      case "plans":
        return (
          <BillingPlansRoute
            initialReferralCode={typeof query.ref === "string" ? query.ref : undefined}
            billingState={plansOnly ? undefined : state}
            currentPlan={state.tier as PlanTierId}
            currentOffer={state.plan}
            allocatedDiskGb={state.capacity?.diskGb?.used}
            subscription={state.subscription}
            complimentary={state.complimentary}
            billingEnabled={state.billing?.enabled === true}
            canChangeSubscription={state.capabilities?.subscriptionChange === true}
          />
        );
      case "topups":
        return <BillingTopups state={state} />;
      case "payment":
        return (
          <BillingPaymentsPanel
            portalAvailable={state.capabilities?.portal === true}
            hasHistory={!isNewCloudCustomer(state)}
          />
        );
      default:
        notFound();
    }
  }

  return (
    <BillingPageView view={{ ...view, workspaceId: state.workspace?.id, plansOnly, topupsAvailable: state.topups?.available === true }}>
      <BillingWorkspaceProvider workspaceId={state.workspace?.id}>
        {(query.checkout === "success" || query.topup === "success") && (
          <BillingCheckoutStatus
            kind={query.topup === "success" ? "topup" : "subscription"}
            checkoutId={typeof query.session_id === "string" ? query.session_id : undefined}
            expectedTier={typeof query.tier === "string" ? query.tier : undefined}
            expectedOffer={typeof query.offer === "string" ? query.offer : undefined}
            expectedInterval={
              query.interval === "monthly" || query.interval === "annual"
                ? query.interval
                : undefined
            }
          />
        )}
        <BillingContent
          key={`${view.contextKey}:${state.workspace?.id ?? "unsubscribed"}`}
          layout={activeTab === "plans" ? "plans" : "details"}
          sidebar={
            plansOnly || activeTab === "plans" ? null : (
              <BillingSidebar state={state} showSubscriptionControls={activeTab === "overview"} />
            )
          }
        >
          {renderTab()}
        </BillingContent>
      </BillingWorkspaceProvider>
    </BillingPageView>
  );
}
