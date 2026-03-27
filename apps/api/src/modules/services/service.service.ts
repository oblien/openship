/**
 * Service business logic — CRUD and compose sync.
 */

import { repos } from "@repo/db";
import { encrypt, decrypt } from "../../lib/encryption";
import { assertProjectAccess } from "../../lib/controller-helpers";
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
  await repos.service.update(serviceId, data);
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
