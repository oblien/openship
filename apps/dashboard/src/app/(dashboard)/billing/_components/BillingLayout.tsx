import { PageContainer } from "@/components/ui/PageContainer";
import { getBillingPageState } from "./billing-state";
import { BillingSidebar } from "./billing-shared";
import { BillingTabBar } from "./BillingTabBar";
import { BillingContent } from "./BillingContent";
import { BillingHeader } from "./BillingHeader";
import { needsCloudPlan } from "@/lib/billing-presentation";

export async function BillingLayout({ children }: { children: React.ReactNode }) {
  const result = await getBillingPageState();
  const state = result.kind === "ok" ? result.state : null;

  // No billing state — cloud not connected, billing not enabled, or the fetch
  // errored. Don't render the header + tab-bar chrome (and its formatters) above
  // an "unavailable" screen: the tab page renders <BillingUnavailable> with the
  // precise reason. This also keeps billing effectively cloud-gated when reached
  // by direct URL / RSC prefetch (the sidebar link is already hidden).
  if (!state) {
    return <PageContainer className="space-y-6">{children}</PageContainer>;
  }

  return (
    <PageContainer className="space-y-6">
      <BillingHeader />

      <BillingTabBar />

      <BillingContent sidebar={<BillingSidebar state={state} />} promotePlan={needsCloudPlan(state)}>
        {children}
      </BillingContent>
    </PageContainer>
  );
}
