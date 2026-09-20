import { notFound } from "next/navigation";
import type { PlanTierId } from "@repo/core";
import { BillingOverview } from "@/components/billing/BillingOverview";
import { BillingUsage } from "@/components/billing/BillingUsage";
import { BillingTopups } from "@/components/billing/BillingTopups";
import { BillingPlansRoute } from "../_components/BillingPlansRoute";
import { BillingCheckoutStatus } from "../_components/BillingCheckoutStatus";
import { InvoicesPanel, PaymentMethodPanel } from "../_components/billing-shared";
import { BillingUnavailable } from "../_components/BillingUnavailable";
import { getBillingPageState } from "../_components/billing-state";
import { isNewCloudCustomer } from "@/lib/billing-presentation";

export default async function BillingTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tab } = await params;
  const query = await searchParams;

  const validTabs = ["overview", "usage", "plans", "topups", "payment", "invoices"];
  if (!validTabs.includes(tab)) {
    notFound();
  }

  const result = await getBillingPageState();

  if (result.kind === "unavailable") {
    return <BillingUnavailable reason={result.reason} />;
  }

  const state = result.state;

  function renderTab() { switch (tab) {
    case "overview":
      return <BillingOverview state={state} />;
    case "usage":
      return <BillingUsage state={state} />;
    case "plans":
      return <BillingPlansRoute currentPlan={state.tier as PlanTierId} subscription={state.subscription} billingEnabled={state.billing?.enabled === true} canChangeSubscription={state.capabilities?.subscriptionChange === true} />;
    case "topups":
      return <BillingTopups state={state} />;
    case "payment":
      return <PaymentMethodPanel portalAvailable={state.capabilities?.portal === true} hasHistory={!isNewCloudCustomer(state)} />;
    case "invoices":
      return <InvoicesPanel portalAvailable={state.capabilities?.portal === true} hasHistory={!isNewCloudCustomer(state)} />;
    default:
      notFound();
  } }

  return <>
    {(query.checkout === "success" || query.topup === "success") && <BillingCheckoutStatus
      kind={query.topup === "success" ? "topup" : "subscription"}
      expectedTier={typeof query.tier === "string" ? query.tier : undefined}
      expectedInterval={query.interval === "monthly" || query.interval === "annual" ? query.interval : undefined}
    />}
    {renderTab()}
  </>;
}
