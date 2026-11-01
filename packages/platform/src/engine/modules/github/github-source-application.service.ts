/** Owner-only HTTP surface for organization-scoped, self-hosted GitHub Apps. */

import type { ExecutionContext } from "../../../context";

import { audit, operationAuditContext } from "../../lib/audit-emitter";
import type {
  TGitHubSourceManifestBody,
  TGitHubSourceManifestConvertBody,
  TGitHubSourceManualBody,
  TGitHubSourceUpdateBody,
} from "@repo/contracts";
import * as service from "@repo/platform/engine/modules/github/github-source.service";

function sourceAuditShape(source: service.PublicGitHubSource) {
  return {
    name: source.name,
    appId: source.appId,
    slug: source.slug,
    apiBaseUrl: source.apiBaseUrl,
    webBaseUrl: source.webBaseUrl,
    isDefault: source.isDefault,
    status: source.status,
  };
}

export async function listSources(ctx: ExecutionContext) {
  const [sources, configuration] = await Promise.all([
    service.listGitHubSources(ctx.organizationId),
    service.getGitHubSourceConfiguration(),
  ]);
  return { data: sources, configuration };
}

export async function beginManifest(ctx: ExecutionContext, body: TGitHubSourceManifestBody) {
  return await service.beginGitHubManifestFlow(ctx, body);
}

export async function convertManifest(ctx: ExecutionContext, body: TGitHubSourceManifestConvertBody) {
  const result = await service.convertGitHubManifest(ctx, body);
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "github.source.created",
    resourceType: "github",
    resourceId: result.source.id,
    after: { ...sourceAuditShape(result.source), registration: "manifest" },
  });
  return { data: result.source, installUrl: result.installUrl };
}

export async function createManualSource(ctx: ExecutionContext, body: TGitHubSourceManualBody) {
  const source = await service.createManualGitHubSource(ctx.organizationId, body);
  const install = await service.createSourceInstallUrl(ctx, source.id);
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "github.source.created",
    resourceType: "github",
    resourceId: source.id,
    after: { ...sourceAuditShape(source), registration: "manual" },
  });
  return { data: source, installUrl: install.url };
}

export async function updateSource(ctx: ExecutionContext, id: string, body: TGitHubSourceUpdateBody) {
  const before = (await service.listGitHubSources(ctx.organizationId)).find((row) => row.id === id);
  const source = await service.updateGitHubSource(ctx.organizationId, id, body);
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "github.source.updated",
    resourceType: "github",
    resourceId: id,
    before: before ? sourceAuditShape(before) : null,
    after: sourceAuditShape(source),
  });
  return source;
}

export async function verifySource(ctx: ExecutionContext, id: string) {
  const source = await service.verifyGitHubSource(ctx.organizationId, id);
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "github.source.verified",
    resourceType: "github",
    resourceId: id,
    after: sourceAuditShape(source),
  });
  return source;
}

export async function setDefaultSource(ctx: ExecutionContext, id: string) {
  const source = await service.setDefaultGitHubSource(ctx.organizationId, id);
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "github.source.defaulted",
    resourceType: "github",
    resourceId: id,
    after: sourceAuditShape(source),
  });
  return source;
}

export async function createInstallUrl(ctx: ExecutionContext, id: string) {
  return await service.createSourceInstallUrl(ctx, id);
}

export async function deleteSource(ctx: ExecutionContext, id: string) {
  const before = (await service.listGitHubSources(ctx.organizationId)).find((row) => row.id === id);
  await service.deleteGitHubSource(ctx.organizationId, id);
  audit.recordAsync(operationAuditContext(ctx), {
    eventType: "github.source.deleted",
    resourceType: "github",
    resourceId: id,
    before: before ? sourceAuditShape(before) : null,
  });
  return { success: true };
}
