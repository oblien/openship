import { notFound, redirect } from "next/navigation";
import { ManagedServerPurchase } from "@/components/servers/managed/ManagedServerPurchase";
import { BillingWorkspaceProvider } from "@/components/billing/BillingWorkspaceContext";
import { CloudBillingLink } from "@/components/billing/CloudBillingLink";
import { getSession } from "@/lib/server/session";
import { isNewCloudPurchase } from "@/lib/billing-links";
import { cloudSpaceHref, type CloudPlanTab } from "@/lib/cloud-spaces";
import { isCloudPurchaseIntent } from "@/lib/cloud-purchase-intent";
import { BillingUnavailable } from "../_components/BillingUnavailable";
import { getBillingPageState } from "../_components/billing-state";
import { BILLING_TABS } from "../_components/billing-tabs";

/** Existing billing bookmarks and provider returns resolve into the selected plan. */
export default async function BillingTabPage({
  params,
  searchParams,
}: {
  params: Promise<{ tab: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { tab } = await params;
  const query = await searchParams;
  const activeTab =
    tab === "invoices" ? "payment" : BILLING_TABS.find((item) => item.key === tab)?.key;
  if (!activeTab) notFound();
  const value = (key: string) =>
    (Array.isArray(query[key]) ? query[key][0] : query[key]) || undefined;
  const workspaceId = value("workspaceId");
  const organizationId = value("organizationId");
  const checkoutReturn = ["checkout", "topup", "session_id"].some(
    (key) => query[key] !== undefined,
  );
  const newServer = isNewCloudPurchase({
    tab: activeTab,
    workspaceId,
    newServer: query.newServer === "1",
    checkoutReturn,
  });
  const requestedPlanId = value("plan");
  const requestedInterval =
    query.interval === "monthly" || query.interval === "annual" ? query.interval : undefined;
  const autoCheckout =
    query.startCheckout === "1" &&
    (query.checkoutIntent === undefined || isCloudPurchaseIntent(query.checkoutIntent));
  const checkoutIntent = isCloudPurchaseIntent(query.checkoutIntent)
    ? query.checkoutIntent
    : undefined;
  const checkoutAttempt = isCloudPurchaseIntent(query.checkoutAttempt)
    ? query.checkoutAttempt
    : undefined;
  const session = await getSession();
  if (organizationId && session?.session.activeOrganizationId !== organizationId) {
    return (
      <CloudBillingLink
        organizationId={organizationId}
        tab={activeTab}
        workspaceId={workspaceId}
        newServer={newServer}
        returnQuery={checkoutReturn ? query : undefined}
        purchase={
          newServer
            ? {
                planId: requestedPlanId,
                interval: requestedInterval,
                startCheckout: autoCheckout,
                checkoutIntent,
                checkoutAttempt,
                referralCode: value("ref"),
              }
            : undefined
        }
        embedded
      />
    );
  }
  if (newServer)
    return (
      <BillingWorkspaceProvider organizationId={organizationId}>
        <ManagedServerPurchase
          initialReferralCode={value("ref")}
          requestedPlanId={requestedPlanId}
          requestedInterval={requestedInterval}
          autoCheckout={autoCheckout}
          checkoutIntent={checkoutIntent}
          checkoutAttempt={checkoutAttempt}
        />
      </BillingWorkspaceProvider>
    );
  // An unscoped history URL cannot pick an arbitrary plan or become a second billing home.
  if (!workspaceId && !checkoutReturn)
    redirect(
      organizationId ? `/billing?organizationId=${encodeURIComponent(organizationId)}` : "/billing",
    );
  const result = await getBillingPageState(workspaceId);
  if (result.kind === "unavailable") {
    if (result.reason === "workspace-removed") redirect("/billing");
    return <BillingUnavailable reason={result.reason} />;
  }
  const serverId = result.state.workspace?.serverId;
  if (workspaceId && result.state.workspace?.id !== workspaceId)
    return <BillingUnavailable reason="billing-unreachable" />;
  if (!serverId) redirect("/billing");
  const target = new URLSearchParams();
  for (const [key, input] of Object.entries(query))
    for (const part of Array.isArray(input) ? input : input === undefined ? [] : [input])
      target.append(key, part);
  if (activeTab === "plans" && !checkoutReturn) target.set("changePlan", "1");
  redirect(
    cloudSpaceHref(
      serverId,
      activeTab === "plans" ? "overview" : (activeTab as CloudPlanTab),
      target,
    ),
  );
}
