import { AppError, type OblienLimits } from "@repo/core";
import { oblienCapacityPoolSchema } from "../../lib/oblien-capacity";

export function monthlyCapacity(resourceLimits: OblienLimits) {
  const capacity = oblienCapacityPoolSchema.safeParse({
    vcpus: resourceLimits.max_total_vcpus,
    memoryMb: resourceLimits.max_total_ram_mb,
    diskGb: resourceLimits.max_total_disk_gb,
    workspaces: resourceLimits.max_workspaces,
  });
  if (!capacity.success)
    throw new AppError("Monthly servers require an explicit resource pool", 400, "BILLING_PLAN_NOT_PURCHASABLE");
  return capacity.data;
}
