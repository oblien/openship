"use client";

import type { BillingState } from "@/lib/api/billing";
import { BillingSubscriptionControls } from "./BillingSubscriptionControls";
import { BillingCapacity } from "./BillingCapacity";
import { CloudUsageGuide } from "./CloudUsageGuide";
import { CloudActivationSteps } from "./CloudActivationSteps";
import { BillingResourceUsage } from "./BillingResourceUsage";

export type { BillingState };
export type BillingData = BillingState;

export function BillingOverview({ state }: { state: BillingState }) {
  return <div className="flex flex-col gap-5">
    <BillingCapacity state={state} />
    <BillingResourceUsage state={state} />
    {state.tier === "free" ? <CloudActivationSteps /> : <BillingSubscriptionControls state={state} />}
    <CloudUsageGuide collapsible />
  </div>;
}
