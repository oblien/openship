import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generateId } from "@repo/core";
import { createDatabase, type DatabaseConnection } from "../factory";
import * as schema from "../schema";
import { createActionsRepo } from "./actions.repo";

let connection: DatabaseConnection;
let actions: ReturnType<typeof createActionsRepo>;
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  actions = createActionsRepo(connection.db);
});
afterAll(() => connection.close());

it("settles only unleased GitHub observer events and preserves native work", async () => {
  const org = generateId("org");
  await connection.db.insert(schema.organization).values({ id: org, name: org });
  const workflow = (controller: "github" | "openship") => ({
    id: generateId("awf"),
    organizationId: org,
    name: controller,
    owner: "acme",
    repo: "app",
    ref: "main",
    path: `.github/workflows/${controller}.yml`,
    controller,
    githubWorkflowId: controller === "github" ? "123" : null,
    definition: { name: controller, jobs: [], triggers: {} },
    runnerIds: [],
    authority: { version: 1 as const, userId: "test", organizationId: org, token: null, restrictions: null },
  });
  const github = workflow("github"), native = workflow("openship");
  await connection.db.insert(schema.actionWorkflow).values([github, native]);
  const payload = { private: "must be released for the observer" };
  for (const [workflowId, deliveryId] of [
    [github.id, "observer"],
    [github.id, "leased"],
    [native.id, "native"],
  ])
    await actions.enqueueDelivery({ organizationId: org, workflowId, deliveryId, eventName: "workflow_run", payload });
  await connection.db
    .update(schema.actionDelivery)
    .set({ leaseOwner: "other-controller", leaseUntil: new Date(Date.now() + 60_000) })
    .where(eq(schema.actionDelivery.deliveryId, "leased"));

  expect(await actions.settleGitHubObserverDeliveries()).toBe(1);
  const rows = await connection.db.select().from(schema.actionDelivery);
  const byDelivery = Object.fromEntries(rows.map((row) => [row.deliveryId, row]));
  expect(byDelivery.observer?.finishedAt).toBeInstanceOf(Date);
  expect(byDelivery.observer?.payload).toEqual({});
  expect(byDelivery.leased?.finishedAt).toBeNull();
  expect(byDelivery.leased?.payload).toEqual(payload);
  expect(byDelivery.native?.finishedAt).toBeNull();
  expect(byDelivery.native?.payload).toEqual(payload);
  expect((await actions.workflow(org, github.id))?.syncAfter.getTime()).toBe(0);
});
