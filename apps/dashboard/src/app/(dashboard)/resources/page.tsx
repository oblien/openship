import { redirect } from "next/navigation";
import { ManagedResourcesPage } from "@/components/resources/ManagedResourcesPage";
import { getSession } from "@/lib/server/session";
import { CloudBillingLink } from "@/components/billing/CloudBillingLink";
import type { CloudPlanTab } from "@/lib/cloud-spaces";

/** Keep space bookmarks while the unscoped entry uses the account's plan overview. */
export default async function ResourcesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  if (typeof query.pool !== "string" || !query.pool) redirect("/billing");
  if (
    typeof query.organizationId === "string" &&
    (await getSession())?.session.activeOrganizationId !== query.organizationId
  ) {
    const tab = (["overview", "usage", "payment", "activity", "topups"] as const).find(
      (value) => value === query.tab,
    );
    return (
      <CloudBillingLink
        organizationId={query.organizationId}
        serverId={query.pool}
        planTab={tab as CloudPlanTab | undefined}
        tab="home"
        returnQuery={query}
      />
    );
  }
  return <ManagedResourcesPage />;
}
