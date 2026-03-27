/**
 * Service business logic — CRUD and compose sync.
 */

import { repos } from "@repo/db";
import { encrypt, decrypt } from "../../lib/encryption";
import { assertProjectAccess } from "../../lib/controller-helpers";
import { resolveDeploymentRuntime } from "../../lib/deployment-runtime";
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
  await assertServiceAccess(projectId, serviceId, userId);

  // Normalize routing: when exposed is turned off, clear routing fields.
  // When domainType changes, clear the irrelevant domain field.
  const patch = { ...data };
  if (patch.exposed === false) {
    patch.exposedPort = undefined;
    patch.domain = undefined;
    patch.customDomain = undefined;
    patch.domainType = "free";
  } else if (patch.domainType === "custom") {
    patch.domain = undefined;
  } else if (patch.domainType === "free") {
    patch.customDomain = undefined;
  }

  await repos.service.update(serviceId, patch);
  return repos.service.findById(serviceId);
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
