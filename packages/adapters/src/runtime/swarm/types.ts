/** Stable, read-only manager identity returned by the initial Swarm probe. */
export interface SwarmManagerInfo {
  engineVersion: string | null;
  apiVersion: string | null;
  localNodeState: "active";
  controlAvailable: true;
  clusterId: string;
  nodeId: string;
  nodeAddress: string | null;
  managerAddress: string | null;
}

export type SwarmProbeFailureCode =
  | "SWARM_MANAGER_UNREACHABLE"
  | "SWARM_INACTIVE"
  | "SWARM_MANAGER_REQUIRED"
  | "SWARM_INVALID_INFO";

/** Lifecycle surface for stack-oriented runtimes, separate from RuntimeAdapter. */
export interface StackRuntimeAdapter {
  readonly name: "swarm";
  probe(): Promise<SwarmManagerInfo>;
  /** The platform owns any shared SSH executor; this adapter has no implicit teardown. */
  dispose?(): Promise<void>;
}
