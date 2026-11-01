/** Provider allocations, rather than instantaneous CPU/RSS usage, consume a pool. */
export interface CloudAllocation {
  cpuCores: number;
  memoryMb: number;
  diskMb: number;
}

export interface CloudCapacityPool {
  cpuCores: { used: number; max: number | null };
  memoryMb: { used: number; max: number | null };
  diskMb: { used: number; max: number | null };
  workspaces: { used: number; max: number | null };
}

export type CloudCapacityDimension = keyof CloudCapacityPool;

export interface CloudCapacityShortfall {
  dimension: CloudCapacityDimension;
  used: number;
  max: number;
  additional: number;
  missing: number;
}

/** A resize reserves its positive delta. Shrinking one dimension must never
 * offset growth in another, or assume that the provider has released it yet. */
export function cloudAllocationShortfalls(
  pool: CloudCapacityPool,
  requested: CloudAllocation,
  existing?: CloudAllocation | null,
  /** Native service builds can create several workspaces in one deployment. */
  additionalWorkspaces = existing ? 0 : 1,
): CloudCapacityShortfall[] {
  const additional = {
    cpuCores: Math.max(0, requested.cpuCores - (existing?.cpuCores ?? 0)),
    memoryMb: Math.max(0, requested.memoryMb - (existing?.memoryMb ?? 0)),
    diskMb: Math.max(0, requested.diskMb - (existing?.diskMb ?? 0)),
    workspaces: additionalWorkspaces,
  };
  return (Object.keys(additional) as CloudCapacityDimension[]).flatMap((dimension) => {
    const { used, max } = pool[dimension];
    // Already-over-limit customers must still be able to release resources.
    if (max === null || additional[dimension] === 0) return [];
    const missing = used + additional[dimension] - max;
    return missing > 1e-9
      ? [{ dimension, used, max, additional: additional[dimension], missing }]
      : [];
  });
}
