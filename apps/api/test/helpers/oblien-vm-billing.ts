/** Build provider HTTP fixtures from OpenShip's saved billing model. This helper
 * is only for fixture construction; production must read native SDK 3 payloads.
 * Customer metadata and other opaque dictionaries are deliberately untouched. */
export function providerBillingFixture(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const source = value as Record<string, unknown>;
  const native = { ...source };
  if ("vcpus" in source && "memoryMb" in source && "diskGb" in source && "workspaces" in source) {
    native.vms = source.workspaces;
    delete native.workspaces;
  }
  if (source.resourceLimits && typeof source.resourceLimits === "object") {
    const limits = { ...(source.resourceLimits as Record<string, unknown>) };
    if ("max_workspaces" in limits) {
      limits.max_vms = limits.max_workspaces;
      delete limits.max_workspaces;
    }
    native.resourceLimits = limits;
  }
  if (source.onOverdraftAction === "stop_workspaces") native.onOverdraftAction = "stop_vms";
  if (source.service === "workspace_vm") native.service = "vm_compute";
  for (const key of [
    "data",
    "capacity",
    "quote",
    "current",
    "next",
    "subscription",
    "offer",
    "policy",
    "pendingChange",
    "change",
    "pendingCheckout",
    "checkout",
  ])
    if (source[key] && typeof source[key] === "object")
      native[key] = providerBillingFixture(source[key]);
  if (Array.isArray(source.presets)) native.presets = source.presets.map(providerBillingFixture);
  return native;
}
