import type { RestorePlanUI } from "@/lib/api";

export function canRequestRestorePlan(deployment: { status: string; isActive?: boolean }): boolean {
  return (
    (deployment.status === "success" || deployment.status === "partial_failure") &&
    !deployment.isActive
  );
}

export type RestoreModeCopy = "instant" | "rebuild" | "mixed" | "reacquire-image" | "none";

export function restoreModeCopy(plan: RestorePlanUI | null): RestoreModeCopy {
  if (!plan || plan.mode === "ineligible") return "none";
  if (plan.mode === "reacquire-image") return "reacquire-image";
  if (plan.mode === "rebuild") return "rebuild";
  if (plan.mode === "redeploy-pinned" && plan.rebuildServices.length > 0) return "mixed";
  return "instant";
}

/** A failed preview remains best-effort-compatible; a definitive API refusal does not. */
export function canConfirmRestore(plan: RestorePlanUI | null): boolean {
  return plan?.mode !== "ineligible";
}
