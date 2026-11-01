import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  createRepositories,
  schema,
  eq,
  type DatabaseConnection,
} from "@repo/db/factory";
import { AppError, generateId } from "@repo/core";
import { ActionWebhookInbox } from "./webhook-inbox";
import { parseActionWorkflow } from "./workflow";

let connection: DatabaseConnection;
let repo: ReturnType<typeof createRepositories>["actions"];
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  repo = createRepositories(connection.db, { encrypt: (v) => v, decrypt: (v) => v }).actions;
}, 60_000);
afterAll(async () => {
  await connection?.close();
});

async function fixture() {
  const org = generateId("org");
  const workflowId = generateId("wf");
  await connection.db.insert(schema.organization).values({ id: org, name: org });
  const source =
    "on: push\njobs:\n  test:\n    runs-on: self-hosted\n    steps:\n      - run: true\n";
  await repo.saveWorkflow({
    id: workflowId,
    organizationId: org,
    name: "CI",
    owner: "acme",
    repo: "app",
    path: ".github/workflows/ci.yml",
    ref: "main",
    source,
    definition: await parseActionWorkflow(source),
    runnerIds: [],
    authority: {
      version: 1,
      userId: "actor",
      organizationId: org,
      token: null,
      restrictions: null,
    },
  });
  const input = {
    organizationId: org,
    workflowId,
    deliveryId: generateId("delivery"),
    eventName: "push",
    payload: { after: "a".repeat(40), private: "repo-payload" },
  };
  await repo.enqueueDelivery(input);
  await repo.enqueueDelivery(input);
  const read = async () =>
    (
      await connection.db
        .select()
        .from(schema.actionDelivery)
        .where(eq(schema.actionDelivery.workflowId, workflowId))
    )[0]!;
  return { org, input, read };
}

describe("durable Actions webhook acceptance", () => {
  it("deduplicates acceptance and retries a provider failure across controller restarts", async () => {
    const f = await fixture();
    const reportError = vi.fn();
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("GitHub unavailable"))
      .mockResolvedValue(undefined);
    await new ActionWebhookInbox({ repo, dispatch, reportError }).tick(new Date(Date.now() + 1));
    let row = await f.read();
    expect(row.attempts).toBe(1);
    expect(row.finishedAt).toBeNull();
    expect(row.payload).toEqual(f.input.payload);
    await new ActionWebhookInbox({ repo, dispatch, reportError }).tick(
      new Date(row.retryAt.getTime() + 1),
    );
    row = await f.read();
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(row.finishedAt).toBeTruthy();
    expect(row.payload).toEqual({});
    expect(row.error).toBeNull();
    await repo.enqueueDelivery(f.input);
    await new ActionWebhookInbox({ repo, dispatch, reportError }).tick(
      new Date(Date.now() + 999999),
    );
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
  it("fences a dead controller and refuses another organization's claim", async () => {
    const f = await fixture();
    const row = await f.read();
    const now = new Date(Date.now() + 1);
    expect(await repo.claimDelivery("other", row.id, "intruder", now)).toBeUndefined();
    expect(await repo.claimDelivery(f.org, row.id, "dead-controller", now)).toBeTruthy();
    expect(await repo.claimDelivery(f.org, row.id, "new-controller", now)).toBeUndefined();
    await connection.db
      .update(schema.actionDelivery)
      .set({ leaseUntil: new Date(0) })
      .where(eq(schema.actionDelivery.id, row.id));
    const dispatch = vi.fn(async () => {});
    await new ActionWebhookInbox({ repo, dispatch, reportError: vi.fn() }).tick(now);
    await repo.finishDelivery(f.org, row.id, "dead-controller", "late write");
    expect((await f.read()).error).toBeNull();
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
  it("stops retrying a revoked delegation and clears its private payload", async () => {
    const f = await fixture();
    const dispatch = vi.fn(async () => {
      throw new AppError("Permission was revoked", 403, "FORBIDDEN");
    });
    await new ActionWebhookInbox({ repo, dispatch, reportError: vi.fn() }).tick(
      new Date(Date.now() + 1),
    );
    expect(await f.read()).toMatchObject({
      payload: {},
      attempts: 1,
      error: "Permission was revoked",
    });
    expect((await f.read()).finishedAt).toBeTruthy();
  });
});
