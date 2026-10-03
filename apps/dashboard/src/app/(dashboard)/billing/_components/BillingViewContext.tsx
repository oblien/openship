"use client";

import { createContext, useContext, useEffect, type ReactNode } from "react";

export interface BillingView {
  contextKey: string;
  requestedWorkspaceId?: string;
  organizationId?: string;
  workspaceId?: string;
  plansOnly: boolean;
}

const BillingViewContext = createContext<(_view: BillingView) => void>(() => {});

export const BillingViewProvider = BillingViewContext.Provider;

/** Let the persistent navigation use the tab's authoritative snapshot, without
 * fetching billing a second time or remounting the header during navigation. */
export function BillingPageView({ view, children }: { view: BillingView; children: ReactNode }) {
  const reportView = useContext(BillingViewContext);
  useEffect(() => reportView(view), [reportView, view]);
  return children;
}
