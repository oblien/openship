import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import type { RuntimeAdapter } from "@repo/adapters";

interface ReadinessTargetOptions {
  runtime: RuntimeAdapter;
  containerId: string;
  primaryPort: number;
  probePort?: number;
  /** An individual replica must never fall back to an unrelated host listener. */
  strict?: boolean;
}

/** Resolve the address the deployment host can actually dial for readiness. */
export async function resolveReadinessTarget(
  options: ReadinessTargetOptions,
): Promise<{ host: string; port: number }> {
  const containerPort = options.probePort ?? options.primaryPort;
  if (options.runtime.name === "bare") {
    return { host: "127.0.0.1", port: containerPort };
  }

  try {
    const info = await options.runtime.getContainerInfo(options.containerId);
    if (options.strict && info?.status !== "running")
      throw new Error("The application instance is not running.");
    // `readiness.port` names a workload/container port. The primary container
    // port is published on the host port, even when it was explicitly selected.
    if (info?.hostPort && containerPort === options.primaryPort) {
      return { host: "127.0.0.1", port: info.hostPort };
    }
    if (options.runtime.supports("containerIp")) {
      const ip = await options.runtime.getContainerIp(options.containerId);
      if (ip) return { host: ip, port: containerPort };
    }
  } catch (diagnosticFailure) {
    observeCaughtError(diagnosticFailure, "platform/engine/modules/deployments/readiness-target");
    if (options.strict)
      throw new Error("The application instance's readiness address could not be verified.");
    // The readiness gate reports the exact fallback address if this also fails.
  }

  if (options.strict)
    throw new Error("The application instance has no reachable readiness address.");

  return { host: "127.0.0.1", port: containerPort };
}
