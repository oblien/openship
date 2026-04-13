import { notFound } from "next/navigation";
import { BillingOverview } from "@/components/billing/BillingOverview";
import { BillingPlansRoute } from "../_components/BillingPlansRoute";
import { InvoicesPanel, MOCK_DATA, PaymentMethodPanel } from "../_components/billing-shared";

export default async function BillingTabPage({
  params,
}: {
  params: Promise<{ tab: string }>;
}) {
  const { tab } = await params;

  switch (tab) {
    case "overview":
      return <BillingOverview data={MOCK_DATA} upgradeHref="/billing/plans" />;
    case "plans":
      return <BillingPlansRoute currentPlan={MOCK_DATA.planId} />;
    case "payment":
      return <PaymentMethodPanel billingData={MOCK_DATA} />;
    case "invoices":
      return <InvoicesPanel billingData={MOCK_DATA} />;
    default:
      notFound();
  }
}