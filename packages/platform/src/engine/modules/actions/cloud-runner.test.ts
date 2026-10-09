import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { generateId } from "@repo/core";
import type { ActionJob, ActionRun, ActionRunner } from "@repo/db";

const state = vi.hoisted(() => ({
  job: {} as Record<string, unknown>,
  rows: [] as Array<Record<string, unknown>>,
  create: vi.fn(),
  get: vi.fn(),
  remove: vi.fn(),
  tokens: vi.fn(),
  balance: vi.fn(),
  entitlement: vi.fn(),
  busy: vi.fn(),
  network: vi.fn(),
  probe: vi.fn(),
  prepare: vi.fn(),
}));
vi.mock("../../config/env", () => ({
  env: { CLOUD_MODE: true, OBLIEN_API_URL: "https://api.example.invalid" },
}));
vi.mock("@repo/adapters", async (original) => ({
  ...(await original<typeof import("@repo/adapters")>()),
  probeActionCapabilities: state.probe,
  ActionsWorker: class {
    prepare = state.prepare;
  },
  Oblien: class {
    workspaces = {
      create: state.create,
      get: state.get,
      delete: state.remove,
      network: { update: state.network },
    };
    constructor(public options: unknown) {}
  },
}));
vi.mock("../../lib/oblien-client", () => ({
  getOblienClient: () => ({ tokens: { create: state.tokens } }),
  getOblienBillingApi: () => ({ getBalance: state.balance, getEntitlement: state.entitlement }),
}));
vi.mock("@repo/db", () => ({
  repos: {
    actions: {
      updateJob: async (_org: string, _id: string, _owner: string, changes: object) =>
        Object.assign(state.job, changes),
      cloudRunners: async () => state.rows.map((row) => ({ ...row })),
      runnerBusy: state.busy,
      disableRunner: async (_org: string, id: string) => {
        state.rows.find((row) => row.id === id)!.enabled = false;
      },
      saveRunner: async (value: Record<string, unknown>) => {
        const row = state.rows.find((row) => row.id === value.id);
        if (row) Object.assign(row, value);
        else state.rows.push(value);
        return value;
      },
    },
  },
}));
import {
  ensureConfiguredActionPools,
  openCloudActionWorker,
  removeCloudActionWorker,
} from "./cloud-runner";

const run = { id: "run-one", organizationId: "org-one" } as ActionRun;
const runner = {
  id: "runner-one",
  organizationId: run.organizationId,
  cloudPoolId: "actions-org-one",
  config: {
    mode: "container",
    labels: ["ubuntu-latest"],
    image: "node:22",
    cpu: 2,
    memoryMb: 4096,
    cloudDiskGb: 25,
    maxParallel: 2,
    allowDockerSocket: false,
  },
} as ActionRunner;
const job = () => ({ ...state.job }) as unknown as ActionJob;
const workspace = () => ({
  id: "workspace-one",
  namespace: runner.cloudPoolId,
  slug: `actions-${createHash("sha256").update(String(state.job.id)).digest("hex").slice(0, 32)}`,
  ready: false,
  status: "starting",
});
const missing = () => Object.assign(new Error("not found"), { status: 404 });

beforeEach(() => {
  vi.resetAllMocks();
  state.rows = [];
  state.job = {
    id: generateId("ajob"),
    organizationId: run.organizationId,
    runId: run.id,
    spec: { timeoutSeconds: 3600 },
    providerRequestedAt: null,
    providerWorkspaceId: null,
  };
  state.tokens.mockResolvedValue({ token: "namespace-token" });
  state.balance.mockResolvedValue({ billingMode: "metered", balance: 100, blocking: false });
  state.entitlement.mockResolvedValue({ billingMode: "metered", capacity: null });
  state.busy.mockResolvedValue(false);
  state.create.mockImplementation(async () => workspace());
  state.get.mockImplementation(async () => workspace());
  state.remove.mockResolvedValue(undefined);
  state.network.mockResolvedValue({ success: true });
  state.probe.mockResolvedValue({
    os: "linux",
    architecture: "x64",
    docker: true,
    git: true,
    node: true,
    distribution: null,
    version: null,
  });
  state.prepare.mockResolvedValue({ binary: "/worker", root: "/actions" });
});
afterEach(() => vi.unstubAllEnvs());

describe("temporary Cloud Actions workers", () => {
  it("creates valid, distinct provider names for case-sensitive job IDs ending in punctuation", async () => {
    const ids = ["ajob_Test_", "ajob_test_", "ajob_Test-", "ajob__--", "ajob_Test"];
    for (const id of ids) {
      Object.assign(state.job, { id, providerRequestedAt: null, providerWorkspaceId: null });
      expect(await openCloudActionWorker(run, job(), runner, "owner", "/assets")).toBeNull();
    }
    const requests = state.create.mock.calls.map(([input]) => input);
    expect(requests).toHaveLength(ids.length);
    expect(new Set(requests.map((input) => input.slug)).size).toBe(ids.length);
    for (const [index, input] of requests.entries()) {
      expect(input.slug).toMatch(/^[a-z0-9][a-z0-9-]{1,126}[a-z0-9]$/);
      expect(input.idempotency_key).toBe(`openship-actions-${ids[index]}`);
    }
  });

  it("uses one namespace-scoped token, durable create key and TTL with ingress closed during provisioning", async () => {
    expect(await openCloudActionWorker(run, job(), runner, "owner", "/assets")).toBeNull();
    expect(state.tokens).toHaveBeenCalledWith({
      scope: "namespace",
      namespace: runner.cloudPoolId,
      ttl: 1800,
    });
    expect(state.create).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: runner.cloudPoolId,
        wait_ready: false,
        mode: "temporary",
        cpus: 2,
        memory_mb: 4096,
        disk_size_mb: 25600,
        idempotency_key: `openship-actions-${state.job.id}`,
        config: expect.objectContaining({
          ttl: 4800,
          ttl_action: "remove",
          network_config: { allow_internet: true, public_ingress: false },
        }),
      }),
    );
    await openCloudActionWorker(run, job(), runner, "owner", "/assets");
    expect(state.create).toHaveBeenCalledOnce();
    expect(state.get).toHaveBeenCalledWith("workspace-one");
    expect(state.network).not.toHaveBeenCalled();
  });

  it("opens only the authenticated runtime port before probing a ready VM and reuses the prepared connection", async () => {
    state.create.mockResolvedValue({ ...workspace(), ready: true, status: "running" });
    state.get.mockResolvedValue({ ...workspace(), ready: true, status: "running" });
    state.probe.mockImplementation(async () => {
      expect(state.network).toHaveBeenCalledWith("workspace-one", {
        public_access: true,
        ingress_ports: [9990],
      });
      return { os: "linux", architecture: "x64", docker: true };
    });
    const opened = await openCloudActionWorker(run, job(), runner, "owner", "/assets");
    expect(opened).toMatchObject({ binary: "/worker", directory: `/actions/jobs/${state.job.id}` });
    await opened!.release();
    Object.assign(state.job, { workerBinary: opened!.binary, directory: opened!.directory });
    const resumed = await openCloudActionWorker(run, job(), runner, "owner", "/assets");
    expect(state.network).toHaveBeenCalledOnce();
    expect(state.probe).toHaveBeenCalledOnce();
    await resumed!.release();
  });

  it("does not prepare or start a worker when its runtime firewall cannot be configured", async () => {
    state.create.mockResolvedValue({ ...workspace(), ready: true, status: "running" });
    state.network.mockRejectedValue(new Error("Network policy update rejected"));
    await expect(openCloudActionWorker(run, job(), runner, "owner", "/assets")).rejects.toThrow(
      "Network policy update rejected",
    );
    expect(state.probe).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
    expect(state.job.providerWorkspaceId).toBe("workspace-one");
  });

  it("does not provision from unpaid or monthly application coverage", async () => {
    for (const balance of [
      { billingMode: "metered", balance: 0 },
      { billingMode: "monthly", balance: 100 },
      { billingMode: "metered", balance: 100, blocking: true },
    ]) {
      state.balance.mockResolvedValue(balance);
      await expect(
        openCloudActionWorker(run, job(), runner, "owner", "/assets"),
      ).rejects.toMatchObject({ code: "ACTIONS_CREDITS_REQUIRED" });
    }
    expect(state.create).not.toHaveBeenCalled();
    expect(state.job.providerRequestedAt).toBeNull();
  });

  it("reuses the original uncertain request during cleanup and confirms absence", async () => {
    state.create.mockRejectedValueOnce(new Error("response lost after acceptance"));
    await expect(openCloudActionWorker(run, job(), runner, "owner", "/assets")).rejects.toThrow(
      "response lost",
    );
    expect(state.job.providerRequestedAt).toBeInstanceOf(Date);
    state.get.mockRejectedValue(missing());
    expect(await removeCloudActionWorker(run, job(), runner, "owner")).toBe(true);
    expect(state.create.mock.calls[1]![0]).toEqual(state.create.mock.calls[0]![0]);
    expect(state.remove).toHaveBeenCalledWith("workspace-one");
  });

  it("clears a definitively rejected first request but retains uncertain provisioning for reconciliation", async () => {
    state.create.mockRejectedValue(Object.assign(new Error("quota denied"), { status: 402 }));
    await expect(
      openCloudActionWorker(run, job(), runner, "owner", "/assets"),
    ).rejects.toMatchObject({ code: "ACTIONS_PROVISIONING_REJECTED" });
    expect(state.job.providerRequestedAt).toBeNull();
    await removeCloudActionWorker(run, job(), runner, "owner");
    expect(state.create).toHaveBeenCalledOnce();
    state.job.providerRequestedAt = new Date();
    await expect(openCloudActionWorker(run, job(), runner, "owner", "/assets")).rejects.toThrow(
      "quota denied",
    );
    expect(state.job.providerRequestedAt).toBeInstanceOf(Date);
  });

  it("rejects a mismatched provider identity and never deletes another job's VM", async () => {
    state.job.providerRequestedAt = new Date();
    state.job.providerWorkspaceId = "workspace-one";
    state.get.mockResolvedValue({ ...workspace(), namespace: "another-tenant" });
    await expect(removeCloudActionWorker(run, job(), runner, "owner")).rejects.toMatchObject({
      code: "ACTIONS_WORKER_IDENTITY_MISMATCH",
    });
    expect(state.remove).not.toHaveBeenCalled();
    await expect(
      openCloudActionWorker(
        { ...run, organizationId: "another-org" },
        job(),
        runner,
        "owner",
        "/assets",
      ),
    ).rejects.toMatchObject({ code: "ACTIONS_POOL_FORBIDDEN" });
  });

  it("never recreates a known lost VM and waits when removal is still in progress", async () => {
    state.job.providerRequestedAt = new Date();
    state.job.providerWorkspaceId = "workspace-one";
    state.job.workerStartedAt = new Date();
    state.get.mockRejectedValue(missing());
    await expect(
      openCloudActionWorker(run, job(), runner, "owner", "/assets"),
    ).rejects.toMatchObject({ code: "ACTIONS_WORKER_LOST" });
    await removeCloudActionWorker(run, job(), runner, "owner");
    expect(state.create).not.toHaveBeenCalled();
    state.get.mockImplementation(async () => workspace());
    expect(await removeCloudActionWorker(run, job(), runner, "owner")).toBe(false);
  });

  it("disables removed pools and drains changed configurations without changing in-flight request resources", async () => {
    const pool = {
      organizationId: run.organizationId,
      namespace: runner.cloudPoolId,
      name: "CI",
      cpu: 2,
      memoryMb: 4096,
      diskGb: 25,
      maxParallel: 2,
      image: "node:22",
      labels: ["ubuntu-latest"],
    };
    vi.stubEnv("OPENSHIP_ACTIONS_CLOUD_POOLS", JSON.stringify([pool]));
    await ensureConfiguredActionPools();
    expect(state.rows[0]!.enabled).toBe(true);
    state.busy.mockResolvedValue(true);
    vi.stubEnv("OPENSHIP_ACTIONS_CLOUD_POOLS", JSON.stringify([{ ...pool, cpu: 4 }]));
    await expect(ensureConfiguredActionPools()).rejects.toMatchObject({
      code: "ACTIONS_POOL_DRAINING",
    });
    expect(state.rows[0]!.enabled).toBe(false);
    expect(state.rows[0]!.config).toMatchObject({ cpu: 2 });
    state.busy.mockResolvedValue(false);
    await ensureConfiguredActionPools();
    expect(state.rows[0]!.config).toMatchObject({ cpu: 4 });
    expect(state.rows[0]!.enabled).toBe(true);
    vi.stubEnv("OPENSHIP_ACTIONS_CLOUD_POOLS", "[]");
    await ensureConfiguredActionPools();
    expect(state.rows[0]!.enabled).toBe(false);
  });
});
