"use client";

import { Icon, type IconName } from "@repo/ui/icons";
import type { PlanTierId } from "@repo/core";

const PLAN_ICONS: Record<PlanTierId, IconName> = {
  free: "bolt-solid",
  hobby: "bolt-solid",
  starter: "rocket-solid",
  pro: "gem",
  team: "layers-solid",
  enterprise: "building-solid",
};

/** Consistent plan marks in the comparison, recommendation and current plan. */
export function PlanIcon({
  planId,
  className = "size-5",
}: {
  planId: PlanTierId;
  className?: string;
}) {
  return <Icon name={PLAN_ICONS[planId]} className={className} aria-hidden="true" />;
}
