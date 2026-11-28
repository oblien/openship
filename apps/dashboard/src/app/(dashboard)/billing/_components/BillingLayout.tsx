"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PageContainer } from "@/components/ui/PageContainer";
import { BillingWorkspaceProvider } from "@/components/billing/BillingWorkspaceContext";
import {
  CloudPurchaseProvider,
  CloudPurchaseTabs,
} from "@/components/billing/CloudPurchaseContext";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { emailPlansHref } from "@repo/core/managed-mail";
import { isNewCloudPurchase, scopedBillingHref } from "@/lib/billing-links";
import { BillingHeader } from "./BillingHeader";
import { BillingPurchaseContent } from "./BillingPurchaseContent";

/** Purchase chrome only. Saved plans own their overview, usage and payments navigation. */
export function BillingLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const query = useSearchParams();
  const scope = useResourceScope();
  const router = useRouter();
  const organizationId = query.get("organizationId");
  const product =
    query.get("product") === "email"
      ? "email"
      : query.get("product") === "manage"
        ? "manage"
        : "monthly";
  const newServer = isNewCloudPurchase({
    tab: pathname.split("/").at(-1),
    workspaceId: query.get("workspaceId") || undefined,
    newServer: query.get("newServer") === "1",
    checkoutReturn: ["checkout", "topup", "session_id"].some((key) => query.has(key)),
  });
  if (!newServer) return children;
  if (product === "email" && query.get("changeMail")) return <PageContainer>{children}</PageContainer>;
  return (
    <PageContainer className="space-y-6">
      <BillingWorkspaceProvider organizationId={query.get("organizationId") || undefined}>
        <CloudPurchaseProvider
          key={`${scope}:${product}`}
          scopeKey={scope}
          tabs="header"
          management
          product={product}
          navigateProduct={(next) =>
            router.push(
              next === "email"
                ? emailPlansHref(null, organizationId)
                : scopedBillingHref(
                    next === "manage" ? "/billing/plans?product=manage" : "/billing/plans",
                    { organizationId },
                  ),
              { scroll: false },
            )
          }
        >
          <BillingHeader />
          <CloudPurchaseTabs />
          <BillingPurchaseContent>{children}</BillingPurchaseContent>
        </CloudPurchaseProvider>
      </BillingWorkspaceProvider>
    </PageContainer>
  );
}
