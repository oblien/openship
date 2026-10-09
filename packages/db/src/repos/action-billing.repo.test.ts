import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createRepositories,
  eq,
  schema,
  type DatabaseConnection,
} from "../factory";
import {
  generateId,
  PRICING,
  actionDepositUnits,
  actionExecutionUnits,
  type ActionJobSpec,
  type ActionWorkflowPlan,
} from "@repo/core";

let connection: DatabaseConnection;
let repos: ReturnType<typeof createRepositories>;
beforeAll(async () => {
  connection = await createDatabase({ driver: "pglite", dataDir: "memory://" });
  repos = createRepositories(connection.db, {
    encrypt: (value) => value,
    decrypt: (value) => value,
  });
}, 60_000);
afterAll(async () => {
  await connection?.close();
});

async function fixture() {
  const org = generateId("org");
  const namespace = `actions-${org.toLowerCase()}`;
  await connection.db.insert(schema.organization).values({ id: org, name: "Actions" });
  const plan = { name: "CI", triggers: { workflow_dispatch: {} }, jobs: [] } as ActionWorkflowPlan;
  const authority = {
    version: 1 as const,
    userId: "owner",
    organizationId: org,
    token: null,
    restrictions: null,
  };
  const workflow = await repos.actions.saveWorkflow({
    id: generateId("wf"),
    organizationId: org,
    name: "CI",
    owner: "acme",
    repo: "app",
    path: ".github/workflows/ci.yml",
    ref: "main",
    definition: plan,
    runnerIds: [],
    authority,
  });
  const run = await repos.actions.createRun({
    id: generateId("run"),
    organizationId: org,
    workflowId: workflow.id,
    idempotencyKey: "one",
    source: "",
    plan,
    authority,
    configuration: {
      owner: "acme",
      repo: "app",
      path: workflow.path,
      defaultBranch: "main",
      runnerIds: [],
      variables: {},
      secrets: {},
    },
    revision: "a".repeat(40),
    ref: "refs/heads/main",
    event: {},
    eventName: "workflow_dispatch",
    actor: "owner",
  });
  await repos.actions.claimRun(org, run.id, "controller");
  const purchase = await repos.actionBilling.createPurchase(
    {
      id: generateId("purchase"),
      organizationId: org,
      idempotencyKey: "deposit-one",
      priceCents: 500,
      request: { namespace, marker: "original" },
    },
    namespace,
  );
  await repos.actionBilling.recordCheckout(org, purchase.id, purchase.id, "encrypted-url");
  const fund = (units = actionDepositUnits(500), status = "completed") =>
    repos.actionBilling.reconcilePurchase(org, purchase.id, purchase.id, units, status);
  const job = async (timeoutSeconds = 21_600) => {
    const id = generateId("job");
    await connection.db
      .insert(schema.actionJob)
      .values({
        id,
        organizationId: org,
        runId: run.id,
        jobKey: id,
        matrixIndex: 0,
        spec: { timeoutSeconds } as ActionJobSpec,
      });
    return id;
  };
  const clean = (id: string) =>
    connection.db
      .update(schema.actionJob)
      .set({ status: "success", finishedAt: new Date(), cleanedAt: new Date() })
      .where(eq(schema.actionJob.id, id));
  return { org, namespace, run, purchase, fund, job, clean };
}

describe("isolated prepaid Actions ledger", () => {
  it("preserves the exact payment request on retries and never treats opening checkout as funding", async () => {
    const f = await fixture();
    const retry = await repos.actionBilling.createPurchase(
      {
        id: generateId("purchase"),
        organizationId: f.org,
        idempotencyKey: "deposit-one",
        priceCents: 500,
        request: { marker: "new attempt" },
      },
      f.namespace,
    );
    expect(retry.id).toBe(f.purchase.id);
    expect(retry.request.marker).toBe("original");
    expect((await repos.actionBilling.budget(f.org))?.fundedUnits).toBe(0);
    await expect(
      repos.actionBilling.createPurchase(
        {
          id: generateId("purchase"),
          organizationId: f.org,
          idempotencyKey: "deposit-one",
          priceCents: 2000,
          request: {},
        },
        f.namespace,
      ),
    ).rejects.toMatchObject({ code: "ACTIONS_CHECKOUT_CONFLICT" });
    expect(await repos.actionBilling.purchase("foreign-org", f.purchase.id)).toBeUndefined();
  });

  it("applies duplicate payment and refund observations once without erasing later purchases", async () => {
    const f = await fixture();
    await Promise.all([f.fund(), f.fund()]);
    expect((await repos.actionBilling.budget(f.org))?.fundedUnits).toBe(actionDepositUnits(500));
    const second = await repos.actionBilling.createPurchase(
      {
        id: generateId("purchase"),
        organizationId: f.org,
        idempotencyKey: "second",
        priceCents: 2000,
        request: {},
      },
      f.namespace,
    );
    await repos.actionBilling.recordCheckout(f.org, second.id, second.id, "encrypted");
    await repos.actionBilling.reconcilePurchase(
      f.org,
      second.id,
      second.id,
      actionDepositUnits(2000),
      "completed",
    );
    await f.fund(actionDepositUnits(250), "partially_refunded");
    expect((await repos.actionBilling.budget(f.org))?.fundedUnits).toBe(actionDepositUnits(2250));
    await f.fund(0, "refunded");
    expect((await repos.actionBilling.budget(f.org))?.fundedUnits).toBe(actionDepositUnits(2000));
    await expect(
      repos.actionBilling.reconcilePurchase(f.org, second.id, f.purchase.id, 1, "completed"),
    ).rejects.toThrow("does not match");
  });

  it("serializes competing reservations and holds the saved price through a catalog change", async () => {
    const f = await fixture();
    await f.fund();
    const rate = PRICING.actions.runners[2]!;
    const jobs = await Promise.all([f.job(), f.job()]);
    const results = await Promise.allSettled(
      jobs.map((id) => repos.actionBilling.reserve(f.org, id, "controller", rate, 1)),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const held = results.find((result) => result.status === "fulfilled")! as PromiseFulfilledResult<
      NonNullable<Awaited<ReturnType<typeof repos.actionBilling.reserve>>>
    >;
    expect(held.value.reservedSeconds).toBe(18_750);
    expect((await repos.actionBilling.budget(f.org))?.reservedUnits).toBe(actionDepositUnits(500));
    expect(
      await repos.actionBilling.reserve(
        f.org,
        held.value.jobId,
        "controller",
        { ...rate, microUsdPerMinute: 32_000 },
        2,
      ),
    ).toEqual(held.value);
    expect(
      await repos.actionBilling.reserve(f.org, held.value.jobId, "stale-controller", rate, 1),
    ).toBeNull();
  });

  it("charges exact worker seconds once and releases unused time only after cleanup", async () => {
    const f = await fixture();
    await f.fund();
    const id = await f.job(3600);
    const rate = PRICING.actions.runners[0]!;
    await repos.actionBilling.reserve(f.org, id, "controller", rate, 1);
    await expect(repos.actionBilling.settle(f.org, id, 7)).rejects.toThrow("cleanup");
    await f.clean(id);
    await Promise.all([
      repos.actionBilling.settle(f.org, id, 7),
      repos.actionBilling.settle(f.org, id, 7),
    ]);
    expect(await repos.actionBilling.budget(f.org)).toMatchObject({
      fundedUnits: actionDepositUnits(500),
      spentUnits: actionExecutionUnits(rate, 7),
      reservedUnits: 0,
    });
    const failed = await f.job();
    await repos.actionBilling.reserve(f.org, failed, "controller", rate, 1);
    await f.clean(failed);
    await repos.actionBilling.settle(f.org, failed, 0);
    expect((await repos.actionBilling.budget(f.org))?.spentUnits).toBe(
      actionExecutionUnits(rate, 7),
    );
  });

  it("blocks refunded funds and keeps another tenant's budget and jobs isolated", async () => {
    const f = await fixture();
    const other = await fixture();
    await f.fund();
    await other.fund();
    const id = await f.job(3600);
    const rate = PRICING.actions.runners[0]!;
    expect(await repos.actionBilling.reserve(other.org, id, "controller", rate, 1)).toBeNull();
    await repos.actionBilling.reserve(f.org, id, "controller", rate, 1);
    await f.clean(id);
    await repos.actionBilling.settle(f.org, id, 60);
    await f.fund(0, "refunded");
    await expect(
      repos.actionBilling.reserve(f.org, await f.job(), "controller", rate, 1),
    ).rejects.toMatchObject({ code: "ACTIONS_CREDITS_REQUIRED" });
    expect(await repos.actionBilling.budget(other.org)).toMatchObject({
      fundedUnits: actionDepositUnits(500),
      spentUnits: 0,
      reservedUnits: 0,
    });
    expect(await repos.actionBilling.charge(other.org, id)).toBeUndefined();
  });
});
