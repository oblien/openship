/**
 * Lifecycle surface for stack-oriented runtimes. The concrete Swarm adapter
 * grows this interface in the manager/discovery stories; keeping the platform
 * slot typed now prevents Swarm from falling through the container runtime.
 */
export interface StackRuntimeAdapter {
  readonly name: "swarm";
}
