import { notFound, redirect } from "next/navigation";
import type { PlanTierId } from "@repo/core";
import { BillingOverview } from "@/components/billing/BillingOverview";
import { BillingUsage } from "@/components/billing/BillingUsage";
import { BillingTopups } from "@/components/billing/BillingTopups";
import { BillingPlansRoute } from "../_components/BillingPlansRoute";
import { BillingCheckoutStatus } from "../_components/BillingCheckoutStatus";
import { BillingSidebar, InvoicesPanel, PaymentMethodPanel } from "../_components/billing-shared";
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

export default async function BillingTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tab } = await params;
  const query = await searchParams;

  const activeTab = BILLING_TABS.find((item) => item.key === tab)?.key;
  if (!activeTab) {
    notFound();
  }

  const workspaceId = (Array.isArray(query.workspaceId) ? query.workspaceId[0] : query.workspaceId) || undefined;
  const organizationId = (Array.isArray(query.organizationId) ? query.organizationId[0] : query.organizationId) || undefined;
  const session = await getSession();
  const view: BillingView = {
    contextKey: `${session?.user.id ?? "local"}:${session?.session.activeOrganizationId ?? ""}`,
    requestedWorkspaceId: workspaceId,
    organizationId,
    plansOnly: false,
  };
  if (organizationId && session?.session.activeOrganizationId !== organizationId) {
    return <BillingPageView view={view}><CloudBillingLink organizationId={organizationId} tab={activeTab === "topups" ? "topups" : "overview"} workspaceId={workspaceId} embedded /></BillingPageView>;
  }
  let result = await getBillingPageState(workspaceId);
  const checkoutReturn = ["checkout", "topup", "session_id"].some(key => query[key] !== undefined);
  if (result.kind === "unavailable" && result.reason === "workspace-required" && !workspaceId && !checkoutReturn) {
    const defaultWorkspaceId = await getDefaultBillingWorkspace();
    if (defaultWorkspaceId) {
      view.workspaceId = defaultWorkspaceId;
      result = await getBillingPageState(defaultWorkspaceId);
    }
  }

  if (result.kind === "unavailable") {
    return <BillingPageView view={view}><BillingContent sidebar={null}><BillingUnavailable reason={result.reason} /></BillingContent></BillingPageView>;
  }

  const state = result.state;
  const plansOnly = isNewCloudCustomer(state);
  if (plansOnly && activeTab !== "plans") {
    redirect(billingTabHref("plans", { ...query, workspaceId: state.workspace?.id ?? workspaceId }));
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
          <PaymentMethodPanel
            portalAvailable={state.capabilities?.portal === true}
            hasHistory={!isNewCloudCustomer(state)}
          />
        );
      case "invoices":
        return (
          <InvoicesPanel
            portalAvailable={state.capabilities?.portal === true}
            hasHistory={!isNewCloudCustomer(state)}
          />
        );
      default:
        notFound();
    }
  }

  return (
    <BillingPageView view={{ ...view, workspaceId: state.workspace?.id, plansOnly }}>
      <BillingWorkspaceProvider workspaceId={state.workspace?.id}>
        <BillingContent
          key={state.workspace?.id ?? "unsubscribed"}
          sidebar={
            plansOnly ? null : (
              <BillingSidebar state={state} showSubscriptionControls={activeTab === "overview"} showPlanAction={activeTab !== "plans"} />
            )
          }
        >
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
          {renderTab()}
        </BillingContent>
      </BillingWorkspaceProvider>
    </BillingPageView>
  );
}
