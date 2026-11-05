"use client";

import { useSearchParams } from "next/navigation";
import { ManagementBilling } from "@/components/billing/ManagementPlan";
import { CloudBillingLink } from "@/components/billing/CloudBillingLink";
import { useSession } from "@/lib/auth-client";

export default function ManagePage() {
  const query = useSearchParams();
  const requested = query?.get("plan");
  const organizationId = query?.get("organizationId");
  const { data: session } = useSession();
  if (organizationId && session?.session.activeOrganizationId !== organizationId) {
    return <CloudBillingLink organizationId={organizationId} tab="manage" embedded
      returnQuery={Object.fromEntries(query?.entries() ?? [])} />;
  }
  return (
    <ManagementBilling
      initialPlan={requested === "basic" || requested === "priority" ? requested : undefined}
    />
  );
}
