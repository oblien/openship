import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { db, repos, schema, seedOwner, seedServer } from "./jobs/_harness";
import { eq, type DatabaseDump } from "@repo/db";
import { ingestSubgraph } from "../../src/modules/cloud/cloud-ingest.service";
import { toAdapterRow } from "@repo/platform/engine/modules/backup-destinations/hydrate-server";

describe("Cloud ingest ownership and atomicity with a real database", () => {
  it("does not accept execution handles merely because the sender omitted export scrubbing", async () => {
    const attacker = await seedOwner();
    const groupId = randomUUID();
    const projectId = randomUUID();
    const deploymentId = randomUUID();
    const dump: DatabaseDump = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      sourceDriver: "pglite",
      scope: { kind: "organization", organizationId: "claimed-source" },
      tables: {
        project_app: [
          { id: groupId, organizationId: "claimed-source", name: "Imported", slug: groupId },
        ],
        project: [
          {
            id: projectId,
            organizationId: "claimed-source",
            groupId,
            name: "Imported",
            slug: projectId,
            activeDeploymentId: deploymentId,
            localPath: "/app/private",
            hostPort: 32001,
          },
        ],
        deployment: [
          {
            id: deploymentId,
            organizationId: "claimed-source",
            projectId,
            branch: "main",
            status: "ready",
            containerId: "unverified-process",
            imageRef: "unverified-image",
            pinned: true,
            artifactRetainedAt: new Date().toISOString(),
            meta: {
              branch: "main",
              serverId: "unverified-server",
              managedWorkspaceId: "unverified-workspace",
              managedServer: {
                projectId,
                ownerWorkspaceId: "unverified-workspace",
                workspaceId: "unverified-vm",
              },
              localPath: "/app/private",
              staticRoot: "/app",
              adopt: true,
            },
          },
        ],
      },
    };
    const original = structuredClone(dump);
    await ingestSubgraph({ organizationId: attacker.orgId, dump });
    expect(await repos.project.findById(projectId)).toMatchObject({
      activeDeploymentId: null,
      localPath: null,
      hostPort: null,
    });
    expect(await repos.deployment.findById(deploymentId)).toMatchObject({
      containerId: null,
      imageRef: null,
      pinned: false,
      artifactRetainedAt: null,
      meta: { branch: "main" },
    });
    expect((await repos.deployment.findById(deploymentId))?.meta).toEqual({ branch: "main" });
    expect(dump).toEqual(original);
  });

  it("rejects a shadow server parent and leaves every destination row untouched", async () => {
    const victim = await seedOwner();
    const attacker = await seedOwner();
    const serverId = await seedServer(victim.orgId);
    const destinationId = randomUUID();
    const groupId = randomUUID();
    const projectId = randomUUID();
    const originalServer = await repos.server.get(serverId);
    const dump: DatabaseDump = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      sourceDriver: "pglite",
      scope: { kind: "organization", organizationId: "claimed-source" },
      tables: {
        servers: [{ id: serverId, organizationId: "claimed-source", name: "shadow" }],
        project_app: [
          { id: groupId, organizationId: "claimed-source", name: "Imported", slug: groupId },
        ],
        project: [
          {
            id: projectId,
            organizationId: "claimed-source",
            groupId,
            name: "Imported",
            slug: projectId,
          },
        ],
        backup_destination: [
          {
            id: destinationId,
            organizationId: "claimed-source",
            name: "Borrowed server",
            kind: "openship_server",
            serverId,
          },
        ],
      },
    };
    await expect(ingestSubgraph({ organizationId: attacker.orgId, dump })).rejects.toThrow(
      /references a servers not present/,
    );
    expect(await repos.server.get(serverId)).toEqual(originalServer);
    expect(await repos.project.findById(projectId)).toBeUndefined();
    expect(await repos.projectGroup.findById(groupId)).toBeUndefined();
    expect(
      await db
        .select()
        .from(schema.backupDestination)
        .where(eq(schema.backupDestination.id, destinationId)),
    ).toEqual([]);
  });

  it("refuses cross-tenant credential hydration even if an old corrupt destination already exists", async () => {
    const victim = await seedOwner();
    const attacker = await seedOwner();
    const serverId = await seedServer(victim.orgId);
    const [destination] = await db
      .insert(schema.backupDestination)
      .values({
        id: randomUUID(),
        organizationId: attacker.orgId,
        name: "Corrupt historical import",
        kind: "openship_server",
        serverId,
      })
      .returning();
    await expect(toAdapterRow(destination)).rejects.toThrow(/no longer exists/);
  });

  it("rolls back an earlier shared-parent insert when a later parent conflicts with another tenant", async () => {
    const victim = await seedOwner();
    const attacker = await seedOwner();
    const foreignGroup = await repos.projectGroup.create({
      organizationId: victim.orgId,
      name: "Victim",
      slug: randomUUID(),
    });
    const originalGroup = await repos.projectGroup.findById(foreignGroup.id);
    const freshGroupId = randomUUID();
    const projectId = randomUUID();
    const dump: DatabaseDump = {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      sourceDriver: "pglite",
      scope: { kind: "organization", organizationId: "claimed-source" },
      tables: {
        project_app: [
          { id: freshGroupId, organizationId: "claimed-source", name: "New", slug: freshGroupId },
          {
            id: foreignGroup.id,
            organizationId: "claimed-source",
            name: "Forged",
            slug: randomUUID(),
          },
        ],
        project: [
          {
            id: projectId,
            organizationId: "claimed-source",
            groupId: foreignGroup.id,
            name: "Injected",
            slug: projectId,
          },
        ],
      },
    };
    await expect(ingestSubgraph({ organizationId: attacker.orgId, dump })).rejects.toThrow(
      /shared parent cannot be reused/,
    );
    expect(await repos.projectGroup.findById(freshGroupId)).toBeUndefined();
    expect(await repos.project.findById(projectId)).toBeUndefined();
    expect(await repos.projectGroup.findById(foreignGroup.id)).toEqual(originalGroup);
  });
});
