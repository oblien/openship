/**
 * Retargeting an `openship_server` destination at a different box was a no-op.
 *
 * `UpdateDestinationInput` had no `serverId` and `updateDestination` never carried one
 * into its allow-listed patch, so the dashboard's server picker sent the field, the
 * PATCH returned 200, the row kept the old server, and every subsequent backup wrote
 * to the machine the operator had just moved away from — including, for an operator
 * decommissioning a box, one they believed was no longer receiving data.
 *
 * The half that had to come with the fix: create guards the incoming serverId against
 * the caller's org, because the destination is what a backup SSHes into. Carrying the
 * field on the patch WITHOUT that check would have converted a silent no-op into
 * cross-org SSH impersonation, so both paths now share `assertServerUsable`.
 */

import { db, repos, schema } from "@repo/db";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createDestination,
  updateDestination,
} from "../../../src/modules/backup-destinations/destination.service";
import { seedOrg } from "../../helpers/seed";

const ctx = (organizationId: string) => ({ organizationId, userId: "usr_1" }) as never;

let orgA: string;
let orgB: string;
let serverA1: string;
let serverA2: string;
let serverB: string;

async function seedServer(organizationId: string, name: string) {
  const id = `srv_${organizationId}_${name}`;
  await db
    .insert(schema.servers)
    .values({ id, organizationId, name, sshHost: `${name}.internal` });
  return id;
}

beforeEach(async () => {
  await db.delete(schema.backupDestination);
  await db.delete(schema.servers);
  orgA = (await seedOrg()).organizationId;
  orgB = (await seedOrg()).organizationId;
  serverA1 = await seedServer(orgA, "box-one");
  serverA2 = await seedServer(orgA, "box-two");
  serverB = await seedServer(orgB, "victim");
});

const createServerDestination = (organizationId: string, serverId: string) =>
  createDestination(ctx(organizationId), {
    name: `dest-${serverId}`,
    kind: "openship_server",
    serverId,
    pathPrefix: "/backups",
  });

describe("updateDestination carries serverId", () => {
  it("retargets the destination at the new server", async () => {
    const created = await createServerDestination(orgA, serverA1);
    const updated = await updateDestination(ctx(orgA), created.id, { serverId: serverA2 });

    expect(updated.serverId).toBe(serverA2);
    // Read back from the row, not the serializer — the row is what a run resolves.
    expect((await repos.backupDestination.findById(created.id))!.serverId).toBe(serverA2);
  });

  it("leaves the server alone when the patch omits it", async () => {
    const created = await createServerDestination(orgA, serverA1);
    const updated = await updateDestination(ctx(orgA), created.id, { name: "renamed" });

    expect(updated.name).toBe("renamed");
    expect(updated.serverId).toBe(serverA1);
  });

  it("refuses another org's server instead of quietly storing it", async () => {
    const created = await createServerDestination(orgA, serverA1);
    await expect(
      updateDestination(ctx(orgA), created.id, { serverId: serverB }),
    ).rejects.toThrow(/not accessible/);
    expect((await repos.backupDestination.findById(created.id))!.serverId).toBe(serverA1);
  });

  it("refuses a server id that does not exist", async () => {
    const created = await createServerDestination(orgA, serverA1);
    await expect(
      updateDestination(ctx(orgA), created.id, { serverId: "srv_ghost" }),
    ).rejects.toThrow(/not accessible/);
  });

  it("refuses to CLEAR the server on an openship_server destination", async () => {
    // `toAdapterRow` calls a serverId-less openship_server row corrupted state, so
    // storing the null would break every run on it rather than disable anything.
    const created = await createServerDestination(orgA, serverA1);
    await expect(
      updateDestination(ctx(orgA), created.id, { serverId: null }),
    ).rejects.toThrow(/require a serverId/);
    expect((await repos.backupDestination.findById(created.id))!.serverId).toBe(serverA1);
  });

  it("refuses a server on a destination kind that has none", async () => {
    const local = await createDestination(ctx(orgA), {
      name: "s3",
      kind: "s3_compatible",
      endpoint: "https://s3.example.com",
      region: "auto",
      bucket: "b",
      accessKeyId: "AK",
      secretAccessKey: "SK",
    });
    await expect(
      updateDestination(ctx(orgA), local.id, { serverId: serverA1 }),
    ).rejects.toThrow(/does not have a server/);
  });

  it("still lets a non-server destination be patched with an explicit null", async () => {
    // The dashboard's shared payload builder can send `serverId: null` for an s3 edit;
    // that is not a retarget and must not become an error.
    const s3 = await createDestination(ctx(orgA), {
      name: "s3b",
      kind: "s3_compatible",
      endpoint: "https://s3.example.com",
      region: "auto",
      bucket: "b",
      accessKeyId: "AK",
      secretAccessKey: "SK",
    });
    await expect(
      updateDestination(ctx(orgA), s3.id, { serverId: null, bucket: "c" }),
    ).resolves.toMatchObject({ bucket: "c" });
  });

  it("create still refuses another org's server", async () => {
    await expect(createServerDestination(orgA, serverB)).rejects.toThrow(/not accessible/);
  });
});
