"use client";

import type { BillingState } from "@/lib/api/billing";
import { BillingCapacity } from "./BillingCapacity";
import { SubscribedServerResources } from "./SubscribedServerResources";
import { CloudCreditAlert } from "./CloudCreditAlert";
import { BillingComputeCoverage } from "./BillingComputeCoverage";
import type { CloudWorkspaceSummary } from "@repo/contracts";

export type { BillingState };
export type BillingData = BillingState;

export function BillingOverview({
  state,
  embedded = false,
  server,
  onUpdated,
}: {
  state: BillingState;
  embedded?: boolean;
  server?: CloudWorkspaceSummary;
  onUpdated?: () => void;
}) {
  return (
    <div className="space-y-5">
      <CloudCreditAlert state={state} />
      <SubscribedServerResources
        state={state}
        embedded={embedded}
        server={server}
        onUpdated={onUpdated}
      />
      <BillingCapacity state={state} embedded={embedded} />
      {state.tier !== "free" && <BillingComputeCoverage state={state} />}
    </div>
  );
}
