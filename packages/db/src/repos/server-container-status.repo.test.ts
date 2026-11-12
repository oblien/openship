import { afterAll, expect, it } from "vitest";
import { closeDb, db, repos, schema } from "../index";

afterAll(() => closeDb());

it("keeps an active swap intact when a scan observes its temporary absence", async () => {
  await db.insert(schema.organization).values({ id: "edge-org", name: "Edge owner", slug: "edge-org" });
  await db.insert(schema.servers).values({ id: "edge-server", organizationId: "edge-org", sshHost: "192.0.2.10" });
  const present = {
    organizationId: "edge-org", serverId: "edge-server", component: "edge" as const,
    runningLabel: "edge:1", pinnedLabel: "edge:2", runningVersion: "1", pinnedVersion: "2",
    behind: true, detail: null,
  };
  await repos.serverContainerStatus.upsert({ ...present, latestInProgress: true });
  const absent = { ...present, runningLabel: null, runningVersion: null, behind: false,
    detail: { down: true, containerMissing: true } };
  await repos.serverContainerStatus.upsert(absent, { onlyWhenIdle: true });
  expect(await repos.serverContainerStatus.get("edge-server", "edge")).toMatchObject({
    runningLabel: "edge:1", behind: true, latestInProgress: true, detail: null,
  });
  await repos.serverContainerStatus.setInProgress("edge-server", "edge", false);
  await repos.serverContainerStatus.upsert(absent, { onlyWhenIdle: true });
  expect(await repos.serverContainerStatus.get("edge-server", "edge")).toMatchObject({
    runningLabel: null, behind: false, latestInProgress: false, detail: { down: true, containerMissing: true },
  });
  await repos.serverContainerStatus.upsert(present);
  expect(await repos.serverContainerStatus.get("edge-server", "edge")).toMatchObject({
    runningLabel: "edge:1", detail: null,
  });
});
