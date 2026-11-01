/**
 * GPU placement decision, kept in a leaf module (no I/O, no heavy imports) so each case is testable
 * without loading the whole preflight dependency chain.
 */
import { effectiveGpu, hasComposeGpuRequest, type HostCapacity } from "@repo/core";
import type { PreflightCheck } from "../modules/deployments/preflight";
import type { DeployableService } from "./deployable-service";

/**
 * Names of the services in a deployment that ask for a GPU (`advanced.gpus`, set by the compose
 * parser from `deploy.resources.reservations.devices` / `gpus` / `runtime: nvidia`).
 */
export function servicesRequestingGpu(
  services: readonly DeployableService[] | undefined,
): string[] {
  return (services ?? [])
    .filter((svc) => hasComposeGpuRequest(svc.advanced))
    .map((svc) => svc.name);
}

/**
 * The GPU check's decision, kept free of I/O so each case is testable. WARN-only by design: the
 * operator may have a GPU the probe cannot see (an older daemon lists no devices, the toolkit is not
 * registered yet), and Docker itself still refuses the create on a box that truly has none. A hard
 * `fail` here would turn a probe blind spot into a blocked deploy; the manual mark on the server
 * ("has GPU") is the way to silence it.
 *
 *  - `capacity === null` (daemon unreachable / not probed) → say nothing about the card; the deploy's
 *    own reachability checks already speak for the box.
 */
export function gpuTargetCheck(input: {
  gpuServices: readonly string[];
  override: "yes" | "no" | null;
  capacity: HostCapacity | null;
}): PreflightCheck | null {
  if (input.gpuServices.length === 0) return null;
  const base: PreflightCheck = { id: "gpu-target", label: "GPU", status: "pass" };
  const eff = effectiveGpu(input.capacity, input.override);
  if (eff.hasGpu) return base;

  const who = input.gpuServices.map((n) => `"${n}"`).join(", ");
  if (input.override === "no") {
    return {
      ...base,
      status: "warn",
      message:
        `${who} ask${input.gpuServices.length === 1 ? "s" : ""} for a GPU, but this server is marked ` +
        `"no GPU". Pick a GPU server, or clear the mark on the server if that is wrong. ` +
        `You can continue; the container will start without a GPU or fail to start.`,
    };
  }
  if (!input.capacity) return null;
  return {
    ...base,
    status: "warn",
    message:
      `${who} ask${input.gpuServices.length === 1 ? "s" : ""} for a GPU, but no NVIDIA runtime was ` +
      `detected on this server. Pick a GPU server, or mark this server as having a GPU if it does ` +
      `(an older Docker daemon cannot report it). You can continue; Docker will refuse to start the ` +
      `container if there is no GPU.`,
  };
}
