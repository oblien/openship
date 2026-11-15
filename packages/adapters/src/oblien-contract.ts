import { DEFAULT_API_BASE_URL } from "oblien";

/** The SDK owns the default. An operator override is a complete API mount. */
export function oblienApiBaseUrl(input = DEFAULT_API_BASE_URL): URL {
  const base = new URL(input);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    (base.protocol !== "https:" &&
      !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))
  ) {
    throw new Error("Oblien API URL must use HTTPS (HTTP is allowed for localhost tests)");
  }
  base.pathname = base.pathname.replace(/\/+$/, "");
  return base;
}

export function oblienApiUrl(base: URL, path: string): URL {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path))
    throw new Error("Oblien request escaped its API origin");
  const root = base.toString().replace(/\/+$/, "") + "/";
  const url = new URL(path.replace(/^\//, ""), root);
  if (url.origin !== base.origin || !url.pathname.startsWith(new URL(root).pathname))
    throw new Error("Oblien request escaped its API mount");
  return url;
}

/** OpenShip's saved Cloud workspace policies are its own persisted contract.
 * Map that count to provider VMs only at the external boundary. */
export function toOblienVmLimits<T extends { max_workspaces?: number | null }>(limits: T) {
  const { max_workspaces, ...rest } = limits;
  return { ...rest, max_vms: max_workspaces };
}

export function toOblienVmCapacity<T extends { workspaces: number }>(capacity: T) {
  const { workspaces, ...rest } = capacity;
  return { ...rest, vms: workspaces };
}

export function toOblienVmPolicy<T extends { onOverdraftAction?: "stop_workspaces" | "block" }>(
  policy: T,
) {
  const { onOverdraftAction, ...rest } = policy;
  return {
    ...rest,
    onOverdraftAction:
      onOverdraftAction === "stop_workspaces" ? ("stop_vms" as const) : onOverdraftAction,
  };
}

export function toOblienVmOffer<
  T extends {
    resourceLimits?: { max_workspaces?: number | null };
    capacity?: { vcpus: number; memoryMb: number; diskGb: number; workspaces: number };
    policy?: { onOverdraftAction?: "stop_workspaces" | "block" };
  },
>(offer: T) {
  const { resourceLimits, capacity, policy, ...rest } = offer;
  return {
    ...rest,
    ...(resourceLimits ? { resourceLimits: toOblienVmLimits(resourceLimits) } : {}),
    ...(capacity ? { capacity: toOblienVmCapacity(capacity) } : {}),
    ...(policy ? { policy: toOblienVmPolicy(policy) } : {}),
  };
}

/** Decode only documented billing-contract nodes. Metadata, signatures and
 * customer dictionaries stay opaque; no recursive word replacement is used. */
export function cloudBillingContract(value: unknown, depth = 0): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  if (depth > 12) throw new Error("Oblien returned an invalid billing contract");
  const source = value as Record<string, unknown>;
  const result = { ...source };
  if ("vcpus" in source && "memoryMb" in source && "diskGb" in source) {
    result.workspaces = source.vms;
    delete result.vms;
  }
  if (
    source.resourceLimits &&
    typeof source.resourceLimits === "object" &&
    !Array.isArray(source.resourceLimits)
  ) {
    const { max_vms, ...rest } = source.resourceLimits as Record<string, unknown>;
    result.resourceLimits = { ...rest, max_workspaces: max_vms };
  }
  if (source.onOverdraftAction === "stop_vms") result.onOverdraftAction = "stop_workspaces";
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
      result[key] = cloudBillingContract(source[key], depth + 1);
  if (Array.isArray(source.presets))
    result.presets = source.presets.map((item) => cloudBillingContract(item, depth + 1));
  return result;
}
