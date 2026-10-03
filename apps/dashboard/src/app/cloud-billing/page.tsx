import { redirect } from "next/navigation";
import { CloudBillingLink } from "@/components/billing/CloudBillingLink";
import { getSession } from "@/lib/server/session";
import { scopedBillingHref } from "@/lib/billing-links";

/** Keep the linked organization through login, before the active-org dashboard gate. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ organizationId?: string; tab?: string; workspaceId?: string }>;
}) {
  const input = await searchParams;
  const organizationId =
    typeof input.organizationId === "string" && input.organizationId.length <= 255
      ? input.organizationId
      : "";
  const tab = input.tab === "topups" ? "topups" : "overview";
  const workspaceId = typeof input.workspaceId === "string" ? input.workspaceId : undefined;
  const session = await getSession();
  if (!session) {
    const query = new URLSearchParams({ organizationId, tab });
    if (workspaceId) query.set("workspaceId", workspaceId);
    const destination = `/cloud-billing?${query}`;
    redirect(`/login?${new URLSearchParams({ returnTo: destination })}`);
  }
  if (organizationId && session.session?.activeOrganizationId === organizationId) {
    redirect(scopedBillingHref(`/billing/${tab}`, { workspaceId, organizationId }));
  }
  return <CloudBillingLink organizationId={organizationId} tab={tab} workspaceId={workspaceId} />;
}
