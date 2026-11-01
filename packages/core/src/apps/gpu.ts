import { ValidationError } from "../errors";
import { hasComposeGpuRequest, normalizeComposeGpuRequests } from "../compose-gpu";
import type { AppTemplate, TemplateServiceSpec } from "../app-templates";

/** A template with GPU requests is required unless it explicitly offers CPU mode. */
export function appGpuRequirement(template: Pick<AppTemplate, "gpu" | "services">) {
  if (!(template.services ?? []).some((service) => hasComposeGpuRequest(service))) return undefined;
  return template.gpu ?? "required";
}

/** Run before creating any project or service. Cloud currently provides no GPU capacity. */
export function resolveAppGpuMode(
  template: Pick<AppTemplate, "gpu" | "services">,
  useGpu: boolean | undefined,
  cloud: boolean,
): boolean {
  const requirement = appGpuRequirement(template);
  if (!requirement && useGpu) throw new ValidationError("This app does not declare GPU support");
  if (requirement === "required" && useGpu === false)
    throw new ValidationError("This app requires an NVIDIA GPU server");
  const enabled = useGpu ?? requirement === "required";
  if (enabled && cloud)
    throw new ValidationError(
      "GPU apps require a self-hosted NVIDIA server. Managed Cloud has no GPU capacity.",
    );
  return enabled;
}

/** Template GPU requests reuse the same validation as Compose, API and Docker. */
export function appServiceGpuConfig(service: TemplateServiceSpec, useGpu: boolean) {
  return useGpu && service.gpus ? { gpus: normalizeComposeGpuRequests(service.gpus) } : {};
}

/** CPU mode must also work when a host uses NVIDIA as Docker's default runtime. */
export function appGpuEnvironment(
  service: TemplateServiceSpec,
  useGpu: boolean,
  stored?: Record<string, string>,
) {
  const environment = { ...service.environment, ...stored };
  if (!service.gpus) return environment;
  if (!useGpu) {
    environment.NVIDIA_VISIBLE_DEVICES = "void";
    environment.CUDA_VISIBLE_DEVICES = "-1";
  } else {
    if (environment.NVIDIA_VISIBLE_DEVICES === "void") delete environment.NVIDIA_VISIBLE_DEVICES;
    if (environment.CUDA_VISIBLE_DEVICES === "-1") delete environment.CUDA_VISIBLE_DEVICES;
  }
  return environment;
}
