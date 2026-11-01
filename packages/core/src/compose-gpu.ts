import { ValidationError } from "./errors";
import type { ComposeGpu, ComposeGpuConfig } from "./types";

export type NormalizedComposeGpu = Omit<ComposeGpu, "driver"> & { driver: "nvidia" };

// Docker's NVIDIA CDI driver can accept fully qualified device names. Keep this
// feature confined to NVIDIA GPUs rather than allowing unrelated host CDI devices.
function isNvidiaGpuId(id: string): boolean {
  const selector = id.startsWith("nvidia.com/gpu=") ? id.slice("nvidia.com/gpu=".length) : id;
  return /^(?:all|\d+(?::\d+)?|GPU-[A-Za-z0-9-]+|MIG-[A-Za-z0-9/-]+)$/.test(selector);
}

/** Shared by Compose imports, API writes and Docker activation. No invalid request becomes "all". */
export function normalizeComposeGpuRequests(value: unknown): NormalizedComposeGpu[] {
  if (value == null) return [];
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > 16) throw new ValidationError("At most 16 GPU request groups are supported");
  return entries.map((entry): NormalizedComposeGpu => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new ValidationError("Each GPU request must be an object");
    const raw = entry as Record<string, unknown>;
    if (
      Object.keys(raw).some(
        (key) => !["driver", "count", "deviceIds", "capabilities", "options"].includes(key),
      )
    )
      throw new ValidationError("GPU requests contain unsupported fields");
    const driver = raw.driver ?? "nvidia";
    if (typeof driver !== "string" || driver.trim().toLowerCase() !== "nvidia")
      throw new ValidationError("GPU requests support only the NVIDIA driver");
    const out: NormalizedComposeGpu = { driver: "nvidia" };
    if (raw.count !== undefined) {
      if (
        raw.count !== "all" &&
        (typeof raw.count !== "number" ||
          !Number.isInteger(raw.count) ||
          raw.count < 0 ||
          raw.count > 64)
      )
        throw new ValidationError("GPU count must be all or an integer between 0 and 64");
      out.count = raw.count as "all" | number;
    }
    if (raw.deviceIds !== undefined) {
      if (raw.count !== undefined)
        throw new ValidationError("GPU count and device_ids cannot be combined");
      if (
        !Array.isArray(raw.deviceIds) ||
        raw.deviceIds.length === 0 ||
        raw.deviceIds.length > 64 ||
        raw.deviceIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 128)
      )
        throw new ValidationError("GPU device_ids must contain between 1 and 64 non-empty IDs");
      out.deviceIds = raw.deviceIds.map((id: string) => id.trim());
      if (out.deviceIds.some((id) => !isNvidiaGpuId(id)))
        throw new ValidationError(
          "GPU device_ids must select NVIDIA GPU indexes, UUIDs or NVIDIA GPU CDI names",
        );
    }
    if (raw.capabilities !== undefined) {
      if (
        !Array.isArray(raw.capabilities) ||
        raw.capabilities.length === 0 ||
        raw.capabilities.length > 16 ||
        raw.capabilities.some((cap) => typeof cap !== "string" || !cap.trim() || cap.length > 64)
      )
        throw new ValidationError("GPU capabilities must contain between 1 and 16 non-empty names");
      out.capabilities = raw.capabilities.map((cap: string) => cap.trim());
    }
    if (raw.options !== undefined) {
      if (
        !raw.options ||
        typeof raw.options !== "object" ||
        Array.isArray(raw.options) ||
        Object.keys(raw.options).length > 16 ||
        Object.entries(raw.options).some(
          ([key, option]) =>
            !key || key.length > 64 || typeof option !== "string" || option.length > 1000,
        )
      )
        throw new ValidationError(
          "GPU driver options must be a string map with at most 16 entries",
        );
      out.options = { ...(raw.options as Record<string, string>) };
    }
    return out;
  });
}

export function validateComposeGpuConfig(
  config: ComposeGpuConfig | null | undefined,
): ComposeGpu[] {
  if (config?.runtime !== undefined && config.runtime !== "nvidia")
    throw new ValidationError("Only the NVIDIA Compose runtime is supported");
  return normalizeComposeGpuRequests(config?.gpus);
}

export function hasComposeGpuRequest(config: ComposeGpuConfig | null | undefined): boolean {
  const requests = config?.gpus ? (Array.isArray(config.gpus) ? config.gpus : [config.gpus]) : [];
  return config?.runtime === "nvidia" || requests.some((request) => request.count !== 0);
}

/** Keep every device request; invalid selectors must never widen to all GPUs. */
export function readComposeGpuConfig(
  svc: Record<string, unknown>,
  interpolate: (value: string) => string = (value) => value,
): { config: ComposeGpuConfig; issues: { field: string; reason: string; blocking?: boolean }[] } {
  const interp = (value: unknown) => (typeof value === "string" ? interpolate(value) : value);
  const issues: { field: string; reason: string; blocking?: boolean }[] = [];
  const config: ComposeGpuConfig = {};
  const runtime = interp(svc.runtime);
  if (typeof runtime === "string" && runtime.trim().toLowerCase() === "nvidia")
    config.runtime = "nvidia";
  const groups: ComposeGpu[] = [];
  const reject = (field: string, reason: string, blocking = true) =>
    issues.push({ field, reason, ...(blocking && { blocking }) });

  const read = (raw: unknown, field: string, implicitGpu: boolean) => {
    try {
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new ValidationError("GPU device reservations must be objects");
      const entry = raw as Record<string, unknown>;
      if (
        Object.keys(entry).some(
          (key) => !["driver", "count", "device_ids", "capabilities", "options"].includes(key),
        )
      )
        throw new ValidationError("GPU device reservations contain unsupported fields");
      const driver = interp(entry.driver);
      const capabilities = Array.isArray(entry.capabilities)
        ? entry.capabilities.map(interp)
        : entry.capabilities;
      const isGpu =
        implicitGpu ||
        (typeof driver === "string" && driver.toLowerCase() === "nvidia") ||
        (Array.isArray(capabilities) &&
          capabilities.some((cap) => typeof cap === "string" && cap.toLowerCase() === "gpu"));
      if (!isGpu) {
        reject(field, "Non-GPU device reservations are not supported and will be ignored", false);
        return;
      }
      if (!implicitGpu && (!Array.isArray(capabilities) || capabilities.length === 0))
        throw new ValidationError("GPU device reservations require capabilities");
      const rawCount = interp(entry.count);
      const count =
        rawCount === -1 || rawCount === "-1"
          ? "all"
          : typeof rawCount === "string" && /^\d+$/.test(rawCount.trim())
            ? Number(rawCount)
            : rawCount;
      const request = {
        ...(driver !== undefined && { driver }),
        ...(count !== undefined && { count }),
        ...(entry.device_ids !== undefined && {
          deviceIds: Array.isArray(entry.device_ids)
            ? entry.device_ids.map((id) => {
                const value = interp(id);
                return typeof value === "number" ? String(value) : value;
              })
            : entry.device_ids,
        }),
        ...(capabilities !== undefined && { capabilities }),
        ...(entry.options !== undefined && {
          options:
            entry.options && typeof entry.options === "object" && !Array.isArray(entry.options)
              ? Object.fromEntries(
                  Object.entries(entry.options).map(([key, value]) => [key, interp(value)]),
                )
              : entry.options,
        }),
      };
      const [normalized] = normalizeComposeGpuRequests(request);
      if (normalized!.count === undefined && normalized!.deviceIds === undefined)
        normalized!.count = "all";
      if (implicitGpu && normalized!.capabilities === undefined) normalized!.capabilities = ["gpu"];
      groups.push(normalized!);
    } catch (error) {
      // diagnostics-ignore: malformed GPU configuration is an expected import validation result.
      if (!(error instanceof ValidationError)) throw error;
      reject(field, error.message);
    }
  };

  const reservations = (
    (svc.deploy as Record<string, unknown> | undefined)?.resources as
      | Record<string, unknown>
      | undefined
  )?.reservations as Record<string, unknown> | undefined;
  if (reservations?.devices !== undefined) {
    const field = "deploy.resources.reservations.devices";
    if (!Array.isArray(reservations.devices)) reject(field, "Device reservations must be a list");
    else for (const entry of reservations.devices) read(entry, field, false);
  }
  if (svc.gpus !== undefined) {
    const short = interp(svc.gpus);
    if (short === "all") groups.push({ driver: "nvidia", count: "all", capabilities: ["gpu"] });
    else if (Array.isArray(short)) for (const entry of short) read(entry, "gpus", true);
    else reject("gpus", "gpus must be all or a list of device requests");
  }
  if (groups.length > 16) {
    reject("gpus", "At most 16 GPU request groups are supported");
    return { config, issues };
  }
  if (groups.length) config.gpus = groups.length === 1 ? groups[0] : groups;
  return { config, issues };
}
