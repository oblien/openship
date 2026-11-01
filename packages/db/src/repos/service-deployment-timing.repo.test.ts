import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "../schema";
import { createEncryption } from "../encryption";
import { createServiceRepo } from "./service.repo";
import { createServiceDeploymentRepo } from "./service-deployment.repo";

const client = new PGlite("memory://");
const db = drizzle(client, { schema });
const repo = createServiceRepo(db, createEncryption("repository-test-secret"));
const outcomes = createServiceDeploymentRepo(db);
const START = new Date("2026-10-20T10:00:00Z");
const runtime = {
  containerId: "running-container",
  imageRef: "worker:v1",
  imageDigest: "sha256:123",
  hostPort: 8080,
  hostPorts: { "3000": 8080 },
  ip: "172.18.0.4",
};

beforeAll(async () => {
  await migrate(db, {
    migrationsFolder: resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle"),
  });
  await client.exec("SET session_replication_role = replica;");
});
afterAll(() => client.close());
afterEach(() => vi.useRealTimers());

function at(elapsed: number) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START.getTime() + elapsed);
}

function key(deploymentId: string) {
  return { deploymentId, serviceId: `svc-${deploymentId}`, serviceName: "worker" };
}

async function row(deploymentId: string) {
  return (await repo.listByDeployment(deploymentId))[0]!;
}

async function begin(deploymentId: string) {
  at(0);
  await repo.startServiceDeploymentTiming(key(deploymentId));
  return row(deploymentId);
}

describe("per-service build/deploy timing", () => {
  it("keeps the first start through runtime upserts and records the complete attempt", async () => {
    const id = "runtime-upsert";
    const initial = await begin(id);
    expect(initial).toMatchObject({ status: "pending", startedAt: START, finishedAt: null, durationMs: null });
    at(2_000);
    await repo.startServiceDeploymentTiming(key(id));
    at(8_500);
    await repo.upsertServiceDeployment({ ...key(id), ...runtime, status: "success" });
    expect(await row(id)).toMatchObject({
      ...runtime, status: "success", startedAt: START,
      finishedAt: new Date(START.getTime() + 8_500), durationMs: 8_500,
    });
    at(20_000);
    await outcomes.update(initial.id, {
      status: "success", startedAt: new Date(), finishedAt: new Date(), durationMs: 1,
    });
    await repo.upsertServiceDeployment({ ...key(id), ...runtime, status: "success" });
    expect(await row(id)).toMatchObject({
      startedAt: START, finishedAt: new Date(START.getTime() + 8_500), durationMs: 8_500,
    });
  });

  it("starts an existing row without changing its runtime or outcome", async () => {
    const id = "start-carried";
    await outcomes.create({
      ...key(id), ...runtime, status: "skipped", reason: "unchanged", errorMessage: "existing fact",
    });
    await begin(id);
    expect(await row(id)).toMatchObject({
      ...runtime, status: "skipped", reason: "unchanged", errorMessage: "existing fact",
      startedAt: START, finishedAt: null, durationMs: null,
    });
  });

  it("cannot add a late start to a finished legacy attempt", async () => {
    const id = "finished-legacy";
    await outcomes.create({
      ...key(id), ...runtime, status: "failure", errorMessage: "historical failure",
      finishedAt: new Date(START.getTime() - 1_000),
    });
    const historical = await row(id);
    await begin(id);
    expect(await row(id)).toEqual(historical);
    at(10_000);
    await repo.finishStartedServiceDeploymentTimings(id);
    expect(await row(id)).toEqual(historical);
    expect(await row(id)).toMatchObject({ startedAt: null, durationMs: null });
  });

  const writers = [
    { name: "failure upsert", status: "failure", finish: (id: string) => repo.markServiceDeploymentFailed({ ...key(id), errorMessage: "failed" }) },
    { name: "cancelled upsert", status: "cancelled", finish: (id: string) => repo.markServiceDeploymentFailed({ ...key(id), status: "cancelled" }) },
    { name: "skip upsert", status: "skipped", finish: (id: string) => repo.markServiceDeploymentSkipped({ ...key(id), reason: "dependency failed" }) },
    { name: "service patch", status: "success", finish: async (id: string) => repo.updateServiceDeployment((await row(id)).id, { status: "success" }) },
    { name: "status patch", status: "failure", finish: async (id: string) => outcomes.updateStatus((await row(id)).id, "failure") },
    { name: "generic patch", status: "cancelled", finish: async (id: string) => outcomes.update((await row(id)).id, { status: "cancelled" }) },
    { name: "indeterminate upsert", status: "indeterminate", finish: (id: string) => repo.upsertServiceDeployment({ ...key(id), ...runtime, status: "indeterminate" }) },
    { name: "legacy ready patch", status: "ready", finish: async (id: string) => outcomes.update((await row(id)).id, { status: "ready" }) },
    { name: "legacy failed patch", status: "failed", finish: async (id: string) => repo.updateServiceDeployment((await row(id)).id, { status: "failed" }) },
  ];

  it.each(writers)("$name finishes once with its outcome and preserves runtime", async ({ name, status, finish }) => {
    const id = name.replaceAll(" ", "-");
    const initial = await begin(id);
    await repo.updateServiceDeployment(initial.id, runtime);
    at(4_321);
    await finish(id);
    const first = await row(id);
    expect(first).toMatchObject({
      ...runtime, status, startedAt: START, finishedAt: new Date(START.getTime() + 4_321), durationMs: 4_321,
    });
    at(90_000);
    await finish(id);
    await repo.startServiceDeploymentTiming(key(id));
    expect(await row(id)).toMatchObject({ ...runtime, startedAt: START, finishedAt: first.finishedAt, durationMs: 4_321 });
  });

  it("keeps unknown legacy and untouched carry durations null", async () => {
    const id = "unknown-carried";
    await outcomes.create({ ...key(id), ...runtime, status: "skipped" });
    at(10_000);
    await repo.markServiceDeploymentSkipped({ ...key(id), reason: "unchanged" });
    expect(await row(id)).toMatchObject({ ...runtime, startedAt: null, finishedAt: null, durationMs: null });
    await repo.upsertServiceDeployment({ ...key(id), ...runtime, status: "success" });
    expect(await row(id)).toMatchObject({ startedAt: null, finishedAt: null, durationMs: null });

    const failed = "unknown-failed";
    await repo.markServiceDeploymentFailed({ ...key(failed), errorMessage: "before start was recorded" });
    expect(await row(failed)).toMatchObject({
      status: "failure", startedAt: null, finishedAt: new Date(START.getTime() + 10_000), durationMs: null,
    });
    at(20_000);
    await repo.markServiceDeploymentFailed(key(failed));
    expect(await row(failed)).toMatchObject({ finishedAt: new Date(START.getTime() + 10_000), durationMs: null });

    const legacy = await outcomes.create({ ...key("legacy-stability"), status: "success" });
    const knownFinish = new Date(START.getTime() + 12_000);
    await outcomes.update(legacy.id, { status: "failure", finishedAt: knownFinish });
    expect(await row("legacy-stability")).toMatchObject({ status: "failure", startedAt: null, finishedAt: knownFinish, durationMs: null });
  });

  it("settles only unfinished started clocks when the parent stops", async () => {
    const id = "parent-stopped";
    await begin(id);
    await repo.updateServiceDeployment((await row(id)).id, runtime);
    await outcomes.create({ ...key(id), serviceId: "untouched", status: "skipped" });
    const alreadyFinished = await outcomes.create({
      ...key(id), serviceId: "completed", status: "success",
      startedAt: START, finishedAt: new Date(START.getTime() + 1_000), durationMs: 1_000,
    });
    await begin("other-parent");
    at(6_000);
    await repo.finishStartedServiceDeploymentTimings(id);
    const rows = await repo.listByDeployment(id);
    expect(rows.find(r => r.serviceId === key(id).serviceId)).toMatchObject({
      ...runtime, status: "pending", startedAt: START,
      finishedAt: new Date(START.getTime() + 6_000), durationMs: 6_000,
    });
    expect(rows.find(r => r.serviceId === "untouched")).toMatchObject({ status: "skipped", startedAt: null, finishedAt: null, durationMs: null });
    expect(rows.find(r => r.id === alreadyFinished.id)).toMatchObject({ durationMs: 1_000 });
    expect(await row("other-parent")).toMatchObject({ finishedAt: null, durationMs: null });
    at(80_000);
    await repo.finishStartedServiceDeploymentTimings(id);
    expect((await repo.listByDeployment(id)).find(r => r.serviceId === key(id).serviceId)).toMatchObject({ durationMs: 6_000 });
  });

  it.each([
    { id: "clock-skew", start: new Date(START.getTime() + 1_000), durationMs: 0 },
    { id: "integer-limit", start: new Date("2020-01-01T00:00:00Z"), durationMs: 2_147_483_647 },
  ])("bounds $id to a nonnegative integer", async ({ id, start, durationMs }) => {
    at(0);
    await repo.startServiceDeploymentTiming({ ...key(id), startedAt: start });
    await repo.markServiceDeploymentFailed(key(id));
    expect(await row(id)).toMatchObject({ startedAt: start, finishedAt: START, durationMs });
  });
});
