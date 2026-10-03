"use client";

import type { BillingState } from "@/lib/api/billing";
import { BillingCapacity } from "./BillingCapacity";
import { CloudUsageGuide } from "./CloudUsageGuide";
import { BillingResourceUsage } from "./BillingResourceUsage";
import { SubscribedServerResources } from "./SubscribedServerResources";

export type { BillingState };
export type BillingData = BillingState;

export function BillingOverview({ state }: { state: BillingState }) {
  return (
    <div className="space-y-5">
      <SubscribedServerResources state={state} />
      <BillingCapacity state={state} />
      <BillingResourceUsage state={state} />
      <CloudUsageGuide collapsible />
    </div>
  );
}
