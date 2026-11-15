import { redirect } from "next/navigation";
import { billingTabHref } from "@/lib/billing-links";
import { BillingHome } from "@/components/billing/BillingHome";
import { getSession } from "@/lib/server/session";
import { CloudBillingLink } from "@/components/billing/CloudBillingLink";

export default async function BillingPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  if (["workspaceId", "checkout", "topup", "session_id"].some(key => query[key] !== undefined))
    redirect(billingTabHref("overview", query));
  const organizationId = typeof query.organizationId === "string" ? query.organizationId : undefined;
  if (organizationId && (await getSession())?.session.activeOrganizationId !== organizationId)
    return <CloudBillingLink organizationId={organizationId} tab="home" />;
  return <BillingHome />;
}
