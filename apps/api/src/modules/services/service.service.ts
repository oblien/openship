/**
 * Service business logic — CRUD and compose sync.
 */

import { repos } from "@repo/db";
import type { LogEntry } from "@repo/adapters";
import { encrypt, decrypt } from "../../lib/encryption";
import { assertProjectAccess, platform } from "../../lib/controller-helpers";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
import { buildServiceRouteDomain, getRoutingBaseDomain } from "../../lib/routing-domains";
import type { TUpdateServiceBody, TSetServiceEnvVarsBody } from "./service.schema";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Verify a service exists and belongs to the given project */
async function assertServiceAccess(projectId: string, serviceId: string, userId: string) {
  const project = await assertProjectAccess(projectId, userId);
  const svc = await repos.service.findById(serviceId);
  if (!svc || svc.projectId !== projectId) {
    throw new Error("service-not-found");
  }
  return { project, svc };
}

function normalizeRoutingPatch(input: {
  exposed?: boolean | null;
  exposedPort?: string | null;
  domain?: string | null;
  customDomain?: string | null;
  domainType?: string | null;
}): {
  exposed: boolean;
  exposedPort: string | null;
  domain: string | null;
  customDomain: string | null;
  domainType: "free" | "custom";
} {
  const trimOrNull = (value?: string | null) => {
    const trimmed = value?.trim();
    return trimmed || null;
  };

  const exposed = input.exposed ?? false;
  if (!exposed) {
    return {
      exposed: false,
      exposedPort: null,
      domain: null,
      customDomain: null,
      domainType: "free",
    };
  }

  const domainType = input.domainType === "custom" ? "custom" : "free";

  return {
    exposed: true,
    exposedPort: trimOrNull(input.exposedPort),
    domain: domainType === "free" ? trimOrNull(input.domain) : null,
    customDomain: domainType === "custom" ? trimOrNull(input.customDomain) : null,
    domainType,
  };
}

// ─── Read ────────────────────────────────────────────────────────────────────

export async function listServices(projectId: string, userId: string) {
  await assertProjectAccess(projectId, userId);
  return repos.service.listByProject(projectId);
}

export async function getService(projectId: string, serviceId: string, userId: string) {
  const { svc } = await assertServiceAccess(projectId, serviceId, userId);
  return svc;
}

// ─── Update ──────────────────────────────────────────────────────────────────

export async function updateService(
  projectId: string,
  serviceId: string,
  userId: string,
  data: TUpdateServiceBody,
) {
  const { project, svc } = await assertServiceAccess(projectId, serviceId, userId);

  // Normalize routing: when exposed is turned off, clear routing fields.
  // When domainType changes, clear the irrelevant domain field.
  const patch = { ...data };

  const touchesRouting = ["exposed", "exposedPort", "domain", "customDomain", "domainType"].some(
    (key) => key in patch,
  );

  if (touchesRouting) {
    const normalized = normalizeRoutingPatch({
      exposed: patch.exposed ?? svc.exposed,
      exposedPort: patch.exposedPort ?? svc.exposedPort,
      domain: patch.domain ?? svc.domain,
      customDomain: patch.customDomain ?? svc.customDomain,
      domainType: patch.domainType ?? svc.domainType,
    });

    patch.exposed = normalized.exposed;
    patch.exposedPort = normalized.exposedPort ?? undefined;
    patch.domain = normalized.domain ?? undefined;
    patch.customDomain = normalized.customDomain ?? undefined;
    patch.domainType = normalized.domainType;
  }

  await repos.service.update(serviceId, patch);
  const updated = await repos.service.findById(serviceId);

  // ── Route management on enable/disable ───────────────────────
  // When disabling a service that is publicly exposed, remove the route.
  // When re-enabling a service that is publicly exposed, re-register the route.
  const enabledChanged = typeof data.enabled === "boolean" && data.enabled !== svc.enabled;
  const exposedChanged = touchesRouting && (patch.exposed !== svc.exposed);

  if (updated && (enabledChanged || exposedChanged)) {
    try {
      const { routing, runtime } = platform();
      const runtimeName = runtime.name;
      const wasRoutable = svc.enabled && svc.exposed;
      const isRoutable = (updated.enabled ?? svc.enabled) && (updated.exposed ?? svc.exposed);

      if (wasRoutable && !isRoutable) {
        // Remove route for old hostname
        const oldRoute = buildServiceRouteDomain({
          project,
          service: svc,
          runtimeName,
          usesManagedRouting: true,
        });
        if (oldRoute) {
          await routing.removeRoute(oldRoute.hostname);
        }
      } else if (!wasRoutable && isRoutable) {
        // Re-register route — need the container IP for the target URL
        const routeDomain = buildServiceRouteDomain({
          project,
          service: updated,
          runtimeName,
          usesManagedRouting: true,
        });
        if (routeDomain && project.activeDeploymentId) {
          const rows = await repos.service.listByDeployment(project.activeDeploymentId);
          const row = rows.find((r) => r.serviceId === serviceId);
          if (row?.ip) {
            const port = updated.exposedPort || row.hostPort?.toString() || "80";
            await routing.registerRoute({
              domain: routeDomain.hostname,
              tls: true,
              targetUrl: `http://${row.ip}:${port}`,
            });
          }
        }
      }
    } catch (err) {
      console.error(`[SERVICE] Failed to update route for ${svc.name}:`, err);
    }
  }

  return updated;
}

// ─── Service Environment Variables ───────────────────────────────────────────

export async function listServiceEnvVars(
  projectId: string,
  serviceId: string,
  userId: string,
  environment?: string,
) {
  await assertServiceAccess(projectId, serviceId, userId);

  const vars = await repos.project.listEnvVars(projectId, environment, serviceId);
  // Decrypt and mask secrets
  return vars.map((v) => ({
    ...v,
    value: v.isSecret ? "••••••••" : decrypt(v.value),
  }));
}

export async function setServiceEnvVars(
  projectId: string,
  serviceId: string,
  userId: string,
  data: TSetServiceEnvVarsBody,
) {
  await assertServiceAccess(projectId, serviceId, userId);

  // Encrypt values before storage
  const encrypted = data.vars.map((v) => ({
    key: v.key,
    value: encrypt(v.value),
    isSecret: v.isSecret,
  }));

  await repos.project.bulkSetEnvVars(projectId, data.environment, encrypted, serviceId);
  return { count: encrypted.length };
}

// ─── Compose Sync ────────────────────────────────────────────────────────────

export async function syncComposeServices(
  projectId: string,
  userId: string,
  parsed: {
    name: string;
    image?: string;
    build?: string;
    dockerfile?: string;
    ports?: string[];
    dependsOn?: string[];
    environment?: Record<string, string>;
    volumes?: string[];
    command?: string;
    restart?: string;
    exposed?: boolean;
    exposedPort?: string;
    domain?: string;
    customDomain?: string;
    domainType?: "free" | "custom";
  }[],
) {
  await assertProjectAccess(projectId, userId);
  return repos.service.syncFromCompose(projectId, parsed);
}

// ─── Service Deployments (per-deployment state) ──────────────────────────────

export async function listServiceDeployments(deploymentId: string) {
  return repos.service.listByDeployment(deploymentId);
}

export async function getActiveServiceContainers(projectId: string, userId: string) {
  const project = await assertProjectAccess(projectId, userId);
  if (!project.activeDeploymentId) return [];
  return repos.service.listByDeployment(project.activeDeploymentId);
}

// ─── Per-service container actions ───────────────────────────────────────────

async function resolveServiceContainer(projectId: string, serviceId: string, userId: string) {
  const project = await assertProjectAccess(projectId, userId);
  if (!project.activeDeploymentId) throw new Error("No active deployment");

  const dep = await repos.deployment.findById(project.activeDeploymentId);
  if (!dep) throw new Error("Active deployment not found");

  const rows = await repos.service.listByDeployment(dep.id);
  const row = rows.find((r) => r.serviceId === serviceId);
  if (!row?.containerId) throw new Error("Service has no running container");

  const runtime = await resolveDeploymentRuntime(dep);
  return { runtime, containerId: row.containerId };
}

export async function startServiceContainer(projectId: string, serviceId: string, userId: string) {
  const { runtime, containerId } = await resolveServiceContainer(projectId, serviceId, userId);
  await runtime.start(containerId);
  return { containerId };
}

export async function stopServiceContainer(projectId: string, serviceId: string, userId: string) {
  const { runtime, containerId } = await resolveServiceContainer(projectId, serviceId, userId);
  await runtime.stop(containerId);
  return { containerId };
}

export async function restartServiceContainer(projectId: string, serviceId: string, userId: string) {
  const { runtime, containerId } = await resolveServiceContainer(projectId, serviceId, userId);
  await runtime.restart(containerId);
  return { containerId };
}

export async function getServiceRuntimeLogs(
  projectId: string,
  serviceId: string,
  userId: string,
  tail?: number,
) {
  const { runtime, containerId } = await resolveServiceContainer(projectId, serviceId, userId);
  return runtime.getRuntimeLogs(containerId, tail);
}

export async function streamServiceRuntimeLogs(
  projectId: string,
  serviceId: string,
  userId: string,
  onLog: (entry: LogEntry) => void,
  opts?: { tail?: number },
) {
  const { runtime, containerId } = await resolveServiceContainer(projectId, serviceId, userId);
  return runtime.streamRuntimeLogs(containerId, onLog, opts);
}
