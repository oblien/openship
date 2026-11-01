"use client";

import { createContext, useContext, type ComponentProps } from "react";
import Link from "next/link";
import { scopedBillingHref, type BillingLinkScope } from "@/lib/billing-links";
export { workspaceBillingHref } from "@/lib/billing-links";

const BillingWorkspaceContext = createContext<BillingLinkScope>({});
export function BillingWorkspaceProvider({
  workspaceId,
  organizationId,
  children,
}: {
  workspaceId?: string;
  organizationId?: string;
  children: React.ReactNode;
}) {
  const parent = useContext(BillingWorkspaceContext);
  return (
    <BillingWorkspaceContext.Provider value={{ workspaceId, organizationId: organizationId ?? parent.organizationId }}>
      {children}
    </BillingWorkspaceContext.Provider>
  );
}
export function useBillingWorkspace() {
  return useContext(BillingWorkspaceContext).workspaceId ?? undefined;
}

export function useBillingScope() {
  return useContext(BillingWorkspaceContext);
}

/** Keep navigation inside the subscription the customer is viewing. */
export function BillingLink({ href, ...props }: ComponentProps<typeof Link>) {
  const scope = useBillingScope();
  return (
    <Link
      {...props}
      href={
        typeof href === "string" && href.startsWith("/billing")
          ? scopedBillingHref(href, scope)
          : href
      }
    />
  );
}
