import "../jobs/_env";
import { afterEach, describe, expect, it } from "vitest";
import { env } from "@repo/platform/engine/config/env";
import { toAdapterRow } from "@repo/platform/engine/modules/backup-destinations/hydrate-server";
import { seedOrg, seedBackupDestination } from "../../helpers/seed";
import { repos } from "@repo/db";

const originalCloud = env.CLOUD_MODE;
afterEach(() => {
  env.CLOUD_MODE = originalCloud;
});
describe("stored backup destination policy", () => {
  it("keeps the stored server's host key when hydrating a backup destination", async () => {
    const org = await seedOrg();
    const server = await repos.server.create({
      organizationId: org.organizationId,
      sshHost: "backup.example.test",
      sshAuthMethod: "password",
      sshPassword: "test-only",
      sshHostKey: Buffer.from("pinned-key").toString("base64"),
    });
    const row = await seedBackupDestination(org.organizationId, {
      kind: "openship_server",
      serverId: server.id,
    });
    expect(await toAdapterRow(row)).toMatchObject({ sshHostKey: server.sshHostKey });
  });
  it.each([true, false])(
    "injects trusted execution policy at consumption, Cloud=%s",
    async (cloud) => {
      const org = await seedOrg();
      const row = await seedBackupDestination(org.organizationId, {
        kind: "s3_compatible",
        endpoint: "http://127.0.0.1",
      });
      env.CLOUD_MODE = cloud;
      // Legacy/imported configuration cannot opt out of the current host policy.
      expect(await toAdapterRow({ ...row, publicNetworkOnly: !cloud } as typeof row)).toMatchObject(
        { publicNetworkOnly: cloud, organizationId: org.organizationId },
      );
    },
  );
});
