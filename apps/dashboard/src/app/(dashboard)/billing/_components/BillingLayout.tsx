"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { PageContainer } from "@/components/ui/PageContainer";
import { BillingWorkspaceProvider } from "@/components/billing/BillingWorkspaceContext";
import {
  CloudPurchaseProvider,
  CloudPurchaseTabs,
} from "@/components/billing/CloudPurchaseContext";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { isNewCloudPurchase } from "@/lib/billing-links";
import { BillingHeader } from "./BillingHeader";
import { BillingPurchaseContent } from "./BillingPurchaseContent";

/** Purchase chrome only. Saved plans own their overview, usage and payments navigation. */
export function BillingLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const query = useSearchParams();
  const scope = useResourceScope();
  const newServer = isNewCloudPurchase({
    tab: pathname.split("/").at(-1),
    workspaceId: query.get("workspaceId") || undefined,
    newServer: query.get("newServer") === "1",
    checkoutReturn: ["checkout", "topup", "session_id"].some((key) => query.has(key)),
  });
  if (!newServer) return children;
  return (
    <PageContainer className="space-y-6">
      <BillingWorkspaceProvider organizationId={query.get("organizationId") || undefined}>
        <CloudPurchaseProvider scopeKey={`${scope}:new`} tabs="header" management>
          <BillingHeader />
          <CloudPurchaseTabs />
          <BillingPurchaseContent>{children}</BillingPurchaseContent>
        </CloudPurchaseProvider>
      </BillingWorkspaceProvider>
    </PageContainer>
  );
}
