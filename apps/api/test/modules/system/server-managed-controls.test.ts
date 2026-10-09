import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomUUID } from "node:crypto";
import { Hono } from "hono";

const h = vi.hoisted(() => ({
  client: {} as any,
  namespaceClient: vi.fn(),
  canWork: vi.fn(),
  activity: vi.fn(),
}));
vi.mock("@repo/platform/engine/config/env", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/config/env")>()),
  env: {
    ...(await original<typeof import("@repo/platform/engine/config/env")>()).env,
    CLOUD_MODE: true,
    OBLIEN_RUNTIME_URL: "https://runtime.example.test",
  },
}));
vi.mock("@repo/platform/engine/lib/oblien-client", () => ({ getOblienClient: () => h.client }));
vi.mock("@repo/platform/engine/lib/openship-cloud", async (original) => ({
  ...(await original<typeof import("@repo/platform/engine/lib/openship-cloud")>()),
  getNamespaceClient: h.namespaceClient,
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-access", () => ({
  assertManagedServerCanWork: h.canWork,
}));
vi.mock("@repo/platform/engine/lib/cloud-workspace-lock", async (original) => {
  const actual = await original<typeof import("@repo/platform/engine/lib/cloud-workspace-lock")>();
  return {
    ...actual,
    withCloudWorkspaceActivity: (...args: Parameters<typeof actual.withCloudWorkspaceActivity>) => {
      h.activity(args[0]);
      return actual.withCloudWorkspaceActivity(...args);
    },
  };
});

import {
  db,
  repos,
  schema,
  seedOwner,
  installFakeRunner,
  type SeededOwner,
} from "../jobs/_harness";
import { eq } from "@repo/db";
import { AppError } from "@repo/core";
import { serverResourceRoutes } from "../../../src/modules/system/server-resource.routes";
import { handleApiError } from "../../../src/middleware/error-handler";
import { scanRoutes } from "../../../src/lib/route-scanner";
import { flushAudit } from "@repo/platform/engine/lib/audit-emitter";
import { withCloudWorkspaceActivity } from "@repo/platform/engine/lib/cloud-workspace-lock";
import { OpenshipClient } from "@repo/sdk/client";
import { SDK_CAPABILITIES } from "@repo/contracts";
import { createShip } from "@repo/sdk/native";
import { getPlatformKernel } from "@repo/platform/engine/lib/platform";

installFakeRunner();
const app = new Hono()
  .onError(handleApiError)
  .use("*", async (c, next) => {
    c.set("clientIp", "192.0.2.72");
    await next();
  })
  .route("/api/system", serverResourceRoutes);
let actor: SeededOwner;
let serverId: string, workspaceId: string, namespace: string, vmId: string;
let network: Record<string, unknown>;
let ssh: Record<string, unknown>;
let runtimeToken: string;
let workloads: Map<string, any>;
let vm: any;
let handle: any;

const jwt = (id = vmId, type = "workspace") =>
  `e30.${Buffer.from(
    JSON.stringify({
      type,
      workspace_id: id,
      token: runtimeToken,
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  ).toString("base64url")}.fixture-signature`;
const notFound = () => Object.assign(new Error("provider missing"), { status: 404 });
async function request(path: string, method = "GET", body?: unknown, owner = actor, id = serverId) {
  const response = await app.request(`/api/system/servers/${id}/${path}`, {
    method,
    headers: { ...owner.auth, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, status: response.status, body: await response.json() };
}
const createInput = () => ({
  name: "Nightly worker",
  command: "node /srv/worker.js",
  workingDirectory: "/srv",
  environment: ["SECRET=private-value"],
  restartPolicy: "on-failure",
  confirm: true,
  idempotencyKey: randomUUID(),
});

beforeEach(async () => {
  vi.clearAllMocks();
  actor = await seedOwner();
  const owner = await repos.cloudWorkspace.create({
    organizationId: actor.orgId,
    name: "Production",
  });
  workspaceId = owner.id;
  namespace = `ns-${randomUUID()}`;
  vmId = randomUUID();
  await repos.cloudWorkspace.setNamespace(workspaceId, actor.orgId, namespace);
  serverId = (await repos.server.findByWorkspace(workspaceId, actor.orgId))!.id;
  const resources = { cpuCores: 2, memoryMb: 8192, diskMb: 32768 };
  await repos.cloudDockerWorkspace.reserve(
    { ownerWorkspaceId: workspaceId, namespace, image: "oblien/docker:29", resources },
    actor.orgId,
  );
  await repos.cloudDockerWorkspace.attach(
    { ownerWorkspaceId: workspaceId },
    actor.orgId,
    namespace,
    vmId,
  );
  await repos.cloudDockerWorkspace.markReady({ ownerWorkspaceId: workspaceId }, actor.orgId, vmId);
  vm = {
    id: vmId,
    namespace,
    image: "oblien/docker:29",
    mode: "permanent",
    status: "running",
    resources: { cpus: 2, memory_mb: 8192, disk_size_mb: 32768 },
    base_os: { distribution: "Alpine", version: "3.22" },
    config: { secret: "DO_NOT_FORWARD" },
  };
  network = {
    allow_internet: true,
    egress: ["*"],
    ingress_ports: [80, "*", 9990],
    ip: "10.0.0.5",
    outbound_ip: "192.0.2.2",
    outbound_mode: "managed",
    private_links: [{ id: "keep" }],
    outbound_proxy: { password: "DO_NOT_FORWARD" },
  };
  ssh = {
    ssh_enabled: false,
    ssh_key_set: false,
    password_auth_enabled: true,
    ssh_password: "DO_NOT_FORWARD",
    connection: {
      user: "root",
      host: "owned-host",
      bastion: "ssh.example.test",
      command: "ssh owned-host",
      ignored: "DO_NOT_FORWARD",
    },
  };
  runtimeToken = "fixture-runtime-secret-before-rotation";
  workloads = new Map();
  handle = {
    ssh: {
      status: vi.fn(async () => ({ ...ssh })),
      enable: vi.fn(async () => {
        ssh.ssh_enabled = true;
        return { success: true, ssh_password: "one-time-password" };
      }),
      disable: vi.fn(async () => {
        ssh.ssh_enabled = false;
        return { success: true };
      }),
      setKey: vi.fn(async () => {
        ssh.ssh_key_set = true;
        return { success: true };
      }),
      setPassword: vi.fn(async () => ({ success: true })),
      connection: vi.fn(async () => ({
        success: true,
        expires_at: new Date(Date.now() + 300000).toISOString(),
        ssh: {
          host: "ssh.example.test",
          port: 22,
          username: "session-user",
          password: "session-password",
          host_key_fingerprint: "SHA256:fixture",
        },
      })),
    },
    network: {
      get: vi.fn(async () => structuredClone(network)),
      update: vi.fn(async (patch: Record<string, unknown>) => {
        Object.assign(network, patch);
        if (patch.allow_internet === false) network.egress = [];
        return { success: true };
      }),
    },
    apiAccess: {
      status: vi.fn(async () => ({ enabled: true, is_running: true, token: "DO_NOT_FORWARD" })),
      getToken: vi.fn(async () => ({ success: true, token: jwt() })),
      enable: vi.fn(async () => ({ success: true, enabled: true })),
      rotateToken: vi.fn(async () => {
        runtimeToken = "fixture-runtime-secret-after-rotation";
        return { success: true };
      }),
    },
    workloads: {
      list: vi.fn(async () => [...workloads.values()]),
      get: vi.fn(async (id: string) => {
        if (!workloads.has(id)) throw notFound();
        return structuredClone(workloads.get(id));
      }),
      status: vi.fn(async (id: string) => {
        if (!workloads.has(id)) throw notFound();
        return { success: true, status: { id, state: workloads.get(id).state } };
      }),
      create: vi.fn(async (input: any) => {
        const saved = { ...input, state: input.enabled ? "running" : "stopped" };
        workloads.set(input.id, saved);
        return saved;
      }),
      start: vi.fn(async (id: string) => {
        Object.assign(workloads.get(id), { state: "running", enabled: true });
        return { success: true };
      }),
      stop: vi.fn(async (id: string) => {
        Object.assign(workloads.get(id), { state: "stopped", enabled: false });
        return { success: true };
      }),
      delete: vi.fn(async (id: string) => {
        workloads.delete(id);
        return { success: true };
      }),
      logs: vi.fn(async () => ({ success: true, logs: "process is ready" })),
    },
    logs: { get: vi.fn(async () => ({ success: true, logs: "guest booted" })) },
  };
  h.client = {
    workspaces: { get: vi.fn(async () => vm), invalidateRuntime: vi.fn() },
    workspace: vi.fn(() => handle),
  };
  h.namespaceClient.mockImplementation(async () => ({ client: h.client, namespace }));
  h.canWork.mockResolvedValue(undefined);
});
afterEach(async () => {
  await flushAudit();
});

describe("managed server controls through real HTTP, policy and SQL ownership", () => {
  it("passes route policy scanning and never starts a server while reading", async () => {
    expect(scanRoutes(app).errors).toEqual([]);
    const result = await request("managed/info");
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(result.body).toMatchObject({
      image: "oblien/docker:29",
      workspaceId: vmId,
      resources: { cpuCores: 2 },
    });
    expect(JSON.stringify(result.body)).not.toContain("DO_NOT_FORWARD");
    expect(h.canWork).not.toHaveBeenCalled();
    expect(result.response.headers.get("cache-control")).toContain("no-store");
  });
  it("rejects anonymous, foreign organization and substituted provider IDs", async () => {
    const foreign = await seedOwner();
    expect(
      (await request("managed/runtime-api/credential", "POST", { confirm: true }, foreign)).status,
    ).toBe(404);
    expect((await request("managed/info", "GET", undefined, actor, vmId)).status).toBe(404);
    expect((await app.request(`/api/system/servers/${serverId}/managed/info`)).status).toBe(401);
    expect(h.namespaceClient).not.toHaveBeenCalled();
    expect(handle.apiAccess.getToken).not.toHaveBeenCalled();
  });
  it("refuses a moved provider VM and mismatched namespace-scoped credentials", async () => {
    vm.namespace = "somebody-else";
    expect((await request("managed/info")).status).toBe(409);
    expect(h.namespaceClient).not.toHaveBeenCalled();
    vm.namespace = namespace;
    h.namespaceClient.mockResolvedValue({ client: h.client, namespace: "somebody-else" });
    expect((await request("managed/ssh")).status).toBe(502);
    expect(handle.ssh.status).not.toHaveBeenCalled();
  });
  it("rejects read-only credentials for secrets and mutations while allowing safe status", async () => {
    await db
      .update(schema.personalAccessToken)
      .set({ readOnly: true })
      .where(eq(schema.personalAccessToken.userId, actor.userId));
    expect((await request("managed/runtime-api")).status).toBe(200);
    for (const path of ["runtime-api/credential", "ssh/connection", "runtime-api/enable"])
      expect((await request(`managed/${path}`, "POST", { confirm: true })).status).toBe(403);
    expect(handle.apiAccess.getToken).not.toHaveBeenCalled();
    expect(handle.ssh.connection).not.toHaveBeenCalled();
  });
  it("strips secrets from status and returns the initial SSH password only when enabling", async () => {
    const read = await request("managed/ssh");
    expect(JSON.stringify(read.body)).not.toContain("DO_NOT_FORWARD");
    const input = { enabled: true, expectedEnabled: false, confirm: true };
    const changed = await request("managed/ssh", "PATCH", input);
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({
      status: { enabled: true },
      initialPassword: "one-time-password",
    });
    const repeated = await request("managed/ssh", "PATCH", input);
    expect(repeated.body.initialPassword).toBeNull();
    expect(handle.ssh.enable).toHaveBeenCalledTimes(1);
    expect(h.canWork).toHaveBeenCalledWith(actor.orgId, workspaceId);
  });
  it("enforces entitlement for new access and still permits revocation", async () => {
    h.canWork.mockRejectedValue(
      new AppError("Server payment required", 402, "CLOUD_BILLING_BLOCKED"),
    );
    expect(
      (await request("managed/runtime-api/credential", "POST", { confirm: true })).status,
    ).toBe(402);
    expect(
      (
        await request("managed/ssh", "PATCH", {
          enabled: true,
          expectedEnabled: false,
          confirm: true,
        })
      ).status,
    ).toBe(402);
    ssh.ssh_enabled = true;
    expect(
      (
        await request("managed/ssh", "PATCH", {
          enabled: false,
          expectedEnabled: true,
          confirm: true,
        })
      ).status,
    ).toBe(200);
    expect(handle.apiAccess.getToken).not.toHaveBeenCalled();
  });
  it("validates public keys, confirmations and bounded passwords before provider calls", async () => {
    const pair = generateKeyPairSync("ed25519");
    const privateKey = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const raw = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
    const wire = Buffer.concat([
      Buffer.from([0, 0, 0, 11]),
      Buffer.from("ssh-ed25519"),
      Buffer.from([0, 0, 0, 32]),
      raw,
    ]);
    const publicKey = `ssh-ed25519 ${wire.toString("base64")} fixture`;
    expect(
      (await request("managed/ssh/key", "PUT", { publicKey: privateKey, confirm: true })).status,
    ).toBe(400);
    expect((await request("managed/ssh/key", "PUT", { publicKey, confirm: true })).status).toBe(
      200,
    );
    expect(handle.ssh.setKey).toHaveBeenCalledExactlyOnceWith({ public_key: publicKey });
    expect(
      (await request("managed/ssh/password", "PUT", { password: "short", confirm: true })).status,
    ).toBe(400);
    expect(
      (
        await request("managed/ssh/password", "PUT", {
          password: "long-secret-pass",
          confirm: false,
        })
      ).status,
    ).toBe(400);
    expect(handle.ssh.setPassword).not.toHaveBeenCalled();
  });
  it("reveals only a workspace gateway token and fences repeat rotations", async () => {
    const revealed = await request("managed/runtime-api/credential", "POST", { confirm: true });
    expect(revealed.status, JSON.stringify(revealed.body)).toBe(200);
    expect(revealed.body.endpoint).toBe("https://runtime.example.test");
    const input = { expectedRevision: revealed.body.revision, confirm: true };
    const rotated = await request("managed/runtime-api/rotate", "POST", input);
    expect(rotated.status, JSON.stringify(rotated.body)).toBe(200);
    expect(rotated.body.revision).not.toBe(input.expectedRevision);
    expect((await request("managed/runtime-api/rotate", "POST", input)).body.code).toBe(
      "MANAGED_RUNTIME_TOKEN_CHANGED",
    );
    expect(handle.apiAccess.rotateToken).toHaveBeenCalledTimes(1);
    expect(h.client.workspaces.invalidateRuntime).toHaveBeenCalledWith(vmId);
    handle.apiAccess.getToken.mockResolvedValue({ token: jwt("another-vm") });
    expect(
      (await request("managed/runtime-api/credential", "POST", { confirm: true })).status,
    ).toBe(502);
  });
  it("keeps the original network response for clients that do not request diagnostics", async () => {
    const legacy = { internetAccess: true, ingressPorts: [80, 9990] };
    expect((await request("network-settings")).body).toEqual(legacy);
    expect((await request("network-settings?details=false")).body).toEqual(legacy);
    expect((await request("network-settings?details=invalid")).status).toBe(400);
    const input = {
      internetAccess: false,
      expectedInternetAccess: true,
      confirm: true,
    };
    for (let retry = 0; retry < 2; retry++) {
      const updated = await request("network-settings", "PATCH", input);
      expect(updated.status).toBe(200);
      expect(updated.body).toEqual({ ...legacy, internetAccess: false });
    }
    expect(handle.network.update).toHaveBeenCalledExactlyOnceWith({ allow_internet: false });
  });
  it("patches only outbound fields, keeps wildcard ingress and rejects a stale form", async () => {
    const before = await request("network-settings?details=true");
    expect(before.body).toMatchObject({
      ingressAll: true,
      privateIp: "10.0.0.5",
      ingressPorts: [80, 9990],
    });
    expect(JSON.stringify(before.body)).not.toContain("DO_NOT_FORWARD");
    const input = {
      internetAccess: true,
      expectedInternetAccess: true,
      expectedRevision: before.body.revision,
      egress: ["api.example.test"],
      confirm: true,
    };
    const updated = await request("network-settings", "PATCH", input);
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      egress: ["api.example.test"],
      revision: expect.any(String),
    });
    expect(handle.network.update).toHaveBeenCalledExactlyOnceWith({
      allow_internet: true,
      egress: ["api.example.test"],
    });
    expect(network.private_links).toEqual([{ id: "keep" }]);
    expect(network.ingress_ports).toEqual([80, "*", 9990]);
    expect(
      (await request("network-settings", "PATCH", { ...input, egress: ["github.com"] })).body.code,
    ).toBe("SERVER_NETWORK_SETTINGS_CHANGED");
    expect((await request("network-settings", "PATCH", input)).status).toBe(200);
    expect(handle.network.update).toHaveBeenCalledTimes(1);
  });
  it("does not rotate twice when the provider commits but loses its reply", async () => {
    const revealed = await request("managed/runtime-api/credential", "POST", { confirm: true });
    const input = { expectedRevision: revealed.body.revision, confirm: true };
    handle.apiAccess.rotateToken.mockImplementationOnce(async () => {
      runtimeToken = "fixture-secret-rotated-before-lost-reply";
      throw new Error("provider reply lost");
    });
    expect((await request("managed/runtime-api/rotate", "POST", input)).status).toBe(502);
    expect((await request("managed/runtime-api/rotate", "POST", input)).body.code).toBe(
      "MANAGED_RUNTIME_TOKEN_CHANGED",
    );
    expect(handle.apiAccess.rotateToken).toHaveBeenCalledTimes(1);
    expect(h.client.workspaces.invalidateRuntime).toHaveBeenCalledWith(vmId);
    const recovered = await request("managed/runtime-api/credential", "POST", { confirm: true });
    expect(recovered.status).toBe(200);
    expect(recovered.body.revision).not.toBe(input.expectedRevision);
  });
  it("rejects arbitrary config, proxy credentials, invalid paths and unbounded requests", async () => {
    expect(
      (
        await request("network-settings", "PATCH", {
          internetAccess: true,
          expectedInternetAccess: true,
          confirm: true,
          private_link_ids: ["foreign"],
        })
      ).status,
    ).toBe(400);
    expect(
      (await request("managed/workloads/logs", "POST", { workloadId: "../foreign", tail: 200 }))
        .status,
    ).toBe(400);
    expect((await request("managed/boot-logs", "POST", { tail: 10000 })).status).toBe(400);
    expect(
      (await request("managed/workloads", "POST", { ...createInput(), vm_on_exit: "stop" })).status,
    ).toBe(400);
    expect(handle.workloads.create).not.toHaveBeenCalled();
    expect(handle.network.update).not.toHaveBeenCalled();
  });
  it("recovers a lost create response with the same stopped process and rejects key reuse", async () => {
    const input = createInput();
    handle.workloads.create.mockImplementationOnce(async (params: any) => {
      workloads.set(params.id, { ...params, state: "stopped" });
      throw new Error("lost provider reply");
    });
    const created = await request("managed/workloads", "POST", input);
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    expect(created.body).toMatchObject({
      id: `openship-manual-${input.idempotencyKey}`,
      state: "stopped",
      manageable: true,
    });
    expect((await request("managed/workloads", "POST", input)).status).toBe(200);
    expect(
      (await request("managed/workloads", "POST", { ...input, command: "different command" })).body
        .code,
    ).toBe("MANAGED_WORKLOAD_CONFLICT");
    expect(handle.workloads.create).toHaveBeenCalledTimes(1);
    expect(handle.workloads.start).not.toHaveBeenCalled();
    expect(JSON.stringify(created.body)).not.toContain("private-value");
    expect(workloads.size).toBe(1);
  });
  it("protects platform, application and unowned manual processes", async () => {
    for (const row of [
      { id: "openship-docker-api-v1", labels: {} },
      { id: "openship-project-release", labels: { "openship.project": "project-a" } },
      {
        id: "openship-manual-foreign",
        labels: { "openship.manual": "v1", "openship.workspace": "other-vm" },
      },
    ])
      workloads.set(row.id, { ...row, state: "running" });
    for (const id of workloads.keys())
      for (const action of ["start", "stop", "delete"]) {
        const result = await request("managed/workloads/control", "POST", {
          workloadId: id,
          action,
          confirm: true,
        });
        expect(result.body.code).toBe("MANAGED_WORKLOAD_PROTECTED");
      }
    expect(handle.workloads.stop).not.toHaveBeenCalled();
    expect(handle.workloads.delete).not.toHaveBeenCalled();
  });
  it("uses live states and distinguishes failed observation from stopped", async () => {
    workloads.set("process-a", {
      id: "process-a",
      state: "running",
      env: ["DO_NOT_FORWARD"],
      cmd: ["private-command"],
    });
    handle.workloads.status.mockResolvedValueOnce({
      success: true,
      status: { id: "process-a", state: "stopped" },
    });
    expect((await request("managed/workloads")).body.workloads[0].state).toBe("stopped");
    handle.workloads.status.mockRejectedValueOnce(new Error("unreachable"));
    const result = await request("managed/workloads");
    expect(result.body.workloads[0].state).toBe("unknown");
    expect(JSON.stringify(result.body)).not.toMatch(/DO_NOT_FORWARD|private-command/);
  });
  it("confirms start, stop and deletion against the owned process", async () => {
    const created = await request("managed/workloads", "POST", createInput());
    const workloadId = created.body.id;
    expect(
      (
        await request("managed/workloads/control", "POST", {
          workloadId,
          action: "start",
          confirm: true,
        })
      ).body.workload.state,
    ).toBe("running");
    expect(
      (
        await request("managed/workloads/control", "POST", {
          workloadId,
          action: "stop",
          confirm: true,
        })
      ).body.workload.state,
    ).toBe("stopped");
    expect(
      (
        await request("managed/workloads/control", "POST", {
          workloadId,
          action: "delete",
          confirm: true,
        })
      ).body,
    ).toEqual({ ok: true, workload: null });
    expect(
      (
        await request("managed/workloads/control", "POST", {
          workloadId,
          action: "delete",
          confirm: true,
        })
      ).status,
    ).toBe(200);
  });
  it("bounds logs and rejects unconfirmed provider mutations", async () => {
    handle.logs.get.mockResolvedValueOnce({
      success: true,
      logs: Array.from({ length: 1000 }, (_, n) => String(n)).join("\n"),
    });
    const logs = await request("managed/boot-logs", "POST", { tail: 3 });
    expect(logs.body).toEqual({ logs: "997\n998\n999", truncated: true });
    handle.ssh.enable.mockResolvedValueOnce({ success: false, error: "http://internal/secret" });
    const failed = await request("managed/ssh", "PATCH", {
      enabled: true,
      expectedEnabled: false,
      confirm: true,
    });
    expect(failed.status).toBe(502);
    expect(JSON.stringify(failed.body)).not.toContain("internal");
    handle.apiAccess.getToken.mockRejectedValueOnce(
      new Error("Authorization: Bearer secret-token at http://private"),
    );
    const error = await request("managed/runtime-api/credential", "POST", { confirm: true });
    expect(error.status).toBe(502);
    expect(JSON.stringify(error.body)).not.toMatch(/secret-token|http:\/\/private/);
  });
  it("serializes settings behind active workspace work", async () => {
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = withCloudWorkspaceActivity(workspaceId, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await started;
    const changing = request("managed/ssh", "PATCH", {
      enabled: true,
      expectedEnabled: false,
      confirm: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handle.ssh.enable).not.toHaveBeenCalled();
    release();
    await held;
    expect((await changing).status).toBe(200);
    expect(handle.ssh.enable).toHaveBeenCalledTimes(1);
  });
  it("rejects a queued change when membership is revoked before admission", async () => {
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = withCloudWorkspaceActivity(workspaceId, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await started;
    const changing = request("managed/ssh", "PATCH", {
      enabled: true,
      expectedEnabled: false,
      confirm: true,
    });
    try {
      // The second call has passed initial authorization and reached the real
      // activity barrier; revoke while it is waiting behind the held activity.
      await vi.waitFor(() => expect(h.activity).toHaveBeenCalledTimes(2));
      await db.delete(schema.member).where(eq(schema.member.userId, actor.userId));
    } finally {
      release();
      await held;
    }
    expect((await changing).status).toBe(404);
    expect(handle.ssh.enable).not.toHaveBeenCalled();
  });
  it("keeps credential, command and environment material out of audit events", async () => {
    await request("managed/runtime-api/credential", "POST", { confirm: true });
    await request("managed/ssh/password", "PUT", {
      password: "secret-password-123",
      confirm: true,
    });
    await request("managed/workloads", "POST", createInput());
    await flushAudit();
    const events = await db
      .select()
      .from(schema.auditEvent)
      .where(eq(schema.auditEvent.organizationId, actor.orgId));
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(events)).not.toMatch(
      /secret-password|private-value|worker\.js|fixture-runtime-secret|fixture-signature/,
    );
  });
  it("keeps native SDK and HTTP SDK on the same typed operations", async () => {
    const user = (await repos.user.findById(actor.userId))!;
    const ship = createShip({
      platform: getPlatformKernel(),
      identity: { resolve: async () => ({ user, sessionId: "managed-controls-test" }) },
    });
    const native = await ship.scope({ identity: "verified", organizationId: actor.orgId });
    const client = new OpenshipClient({
      baseUrl: "http://fixture.test/api",
      token: actor.token,
      organizationId: actor.orgId,
      fetch: (url, init) =>
        String(url).endsWith("/health")
          ? Promise.resolve(Response.json({ sdk: SDK_CAPABILITIES }))
          : app.request(String(url), init),
    });
    for (const servers of [native.servers, client.servers]) {
      expect(await servers.managedInfo(serverId)).toMatchObject({ workspaceId: vmId });
      expect((await servers.get(serverId)).capabilities).not.toHaveProperty("managedControls");
      expect(await servers.getNetworkSettings(serverId)).toEqual({
        internetAccess: true,
        ingressPorts: [80, 9990],
      });
      expect(await servers.getNetworkSettings(serverId, { details: true })).toMatchObject({
        egress: ["*"],
        revision: expect.any(String),
        ingressAll: true,
      });
      const input = createInput();
      expect(await servers.createManagedWorkload(serverId, input as any)).toMatchObject({
        id: `openship-manual-${input.idempotencyKey}`,
      });
      expect(await servers.managedRuntimeCredential(serverId, { confirm: true })).toMatchObject({
        endpoint: "https://runtime.example.test",
      });
    }
  });
  it("does not attach malformed credential responses to SDK errors", async () => {
    const client = new OpenshipClient({
      baseUrl: "http://fixture.test/api",
      token: actor.token,
      organizationId: actor.orgId,
      fetch: async (url) =>
        Response.json(
          String(url).endsWith("/health")
            ? { sdk: SDK_CAPABILITIES }
            : { token: "must-not-appear-in-error", unexpected: true },
        ),
    });
    const calls = [
      () =>
        client.servers.setManagedSsh(serverId, {
          enabled: true,
          expectedEnabled: false,
          confirm: true,
        }),
      () => client.servers.managedSshConnection(serverId, { confirm: true }),
      () => client.servers.managedRuntimeCredential(serverId, { confirm: true }),
      () =>
        client.servers.rotateManagedRuntimeCredential(serverId, {
          expectedRevision: "a".repeat(64),
          confirm: true,
        }),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ status: 502, body: null });
    }
  });
});
