import type { VerifiedIdentity, PermissionRepositories, StoredDeployment } from "../src";
import type { Permission } from "@repo/core";
import { deploymentFixture } from "../../contracts/test/fixtures";

export function authorizationFixture() {
  const members = new Map<string, { id: string; role: string }>();
  const projects = new Map<string, { organizationId: string }>();
  const deployments = new Map<string, { projectId: string }>();
  const services = new Map<string, { projectId: string }>();
  const domains = new Map<string, { projectId: string }>();
  const servers = new Map<string, { organizationId: string }>();
  const grants = new Map<string, { permissions: Permission[] }>();
  const tokenGrants = new Map<string, { permissions: Permission[] }>();
  const findGrant = (table: typeof grants, prefix: string, type: string, id: string) =>
    table.get(`${prefix}:${type}:${id}`) ?? table.get(`${prefix}:${type}:*`) ?? null;
  const repos: PermissionRepositories = {
    member: { find: async (org, user) => members.get(`${org}:${user}`) },
    project: { findById: async (id) => projects.get(id), findEnvVarById: async () => null },
    deployment: { findById: async (id) => deployments.get(id), findBuildSession: async () => null },
    resourceGrant: {
      findForResource: async (org, user, type, id) => findGrant(grants, `${org}:${user}`, type, id),
    },
    server: { get: async (id) => servers.get(id) },
    backupDestination: { findById: async () => null },
    domain: { findById: async (id) => domains.get(id) },
    service: { findById: async (id) => services.get(id) },
    backupPolicy: { findById: async () => null },
    backupRun: { findById: async () => null },
    backupRestore: { findById: async () => null },
  };
  return {
    members,
    projects,
    deployments,
    services,
    domains,
    servers,
    grants,
    tokenGrants,
    repos,
    grantSourceFor: (ctx: { tokenScope?: { tokenId: string } | null }) =>
      ctx.tokenScope
        ? {
            findForResource: async (_org: string, _user: string, type: string, id: string) =>
              findGrant(tokenGrants, ctx.tokenScope!.tokenId, type, id),
          }
        : repos.resourceGrant,
  };
}

export const alice: VerifiedIdentity = {
  user: { id: "alice", email: "alice@example.test", name: "Alice" },
  sessionId: "verified-host-session",
};

export function storedDeployment(
  projectId = "project-a",
  organizationId = "org-a",
): StoredDeployment {
  const deployment = deploymentFixture(projectId, organizationId);
  return {
    ...deployment,
    createdAt: new Date(deployment.createdAt),
    updatedAt: new Date(deployment.updatedAt),
    artifactRetainedAt: deployment.artifactRetainedAt
      ? new Date(deployment.artifactRetainedAt)
      : null,
  };
}
