"use client";

import { useSearchParams } from "next/navigation";
import { ManagementBilling } from "@/components/billing/ManagementPlan";

export default function ManagePage() {
  const requested = useSearchParams()?.get("plan");
  return (
    <ManagementBilling
      initialPlan={requested === "basic" || requested === "priority" ? requested : undefined}
    />
  );
}
