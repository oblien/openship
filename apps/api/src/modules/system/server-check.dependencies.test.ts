import type { ExecutionContext, PermissionInput } from "@repo/platform";
import type { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  assert: vi.fn(async (_ctx: ExecutionContext, _input: PermissionInput) => undefined),
  checkComponents: vi.fn(),
  deliverManagedImage: vi.fn(async () => ({ delivered: false })),
  dockerInstaller: vi.fn(),
  edgeInstaller: vi.fn(),
  ensureEdge: vi.fn(),
  recoverInterruptedTakeover: vi.fn(async () => undefined),
  refreshServerContainer: vi.fn(async () => undefined),
  streamSSE: vi.fn(),
  withExecutor: vi.fn(),
  refreshAuthentication: vi.fn(),
}));

vi.mock("@repo/db", () => ({
  repos: {
    server: {
      get: vi.fn(async () => undefined),
      getInOrganization: vi.fn(async (id: string) => ({ id, organizationId: "org1", isLocal: false, sshHost: "203.0.113.10", sshAuthMethod: "key", sshPrivateKey: "supplied-test-key" })),
      list: vi.fn(async () => []),
    },
    member: { find: vi.fn(async () => null) },
    serverContainer: { list: vi.fn(async () => []) },
  },
}));

vi.mock("@repo/adapters", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkComponents: h.checkComponents,
    COMPONENT_INSTALLERS: {
      ...(actual.COMPONENT_INSTALLERS as Record<string, unknown>),
      docker: h.dockerInstaller,
      edge: h.edgeInstaller,
    },
    ensureEdge: h.ensureEdge,
    recoverInterruptedTakeover: h.recoverInterruptedTakeover,
  };
});

vi.mock("@repo/platform/engine/config/index", async (importOriginal) => {
  const actual = await importOriginal<{ env: Record<string, unknown> }>();
  return {
    ...actual,
    env: { ...actual.env, CLOUD_MODE: false, DEPLOY_MODE: "bare" },
  };
});

vi.mock("../../lib/permission", () => ({ permission: { assert: h.assert } }));
vi.mock("../../lib/request-context", () => ({
  getRequestContext: () => ({ userId: "u1", organizationId: "org1", role: "owner" }),
}));
vi.mock("@repo/platform/engine/lib/ssh-manager", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sshManager: { withExecutor: h.withExecutor, refreshAuthentication: h.refreshAuthentication },
}));
vi.mock("../../lib/sse", () => ({ streamSSE: h.streamSSE }));
vi.mock("@repo/platform/engine/lib/deliver-managed-image", () => ({
  deliverManagedImage: h.deliverManagedImage,
}));
vi.mock("@repo/platform/engine/modules/system/server-containers.service", () => ({
  refreshServerContainer: h.refreshServerContainer,
}));

import { checkServer as checkServerHandler, installComponent as installComponentHandler, installStream } from "./server-check.controller";

const executor = { exec: vi.fn(async () => "") };

function component(name: string, healthy: boolean) {
  return {
    name,
    label: name,
    description: `${name} component`,
    installable: true,
    installed: healthy,
    running: healthy,
    healthy,
    message: healthy ? `${name} ready` : `${name} missing`,
  };
}

function context(body: unknown) {
  const sent: { body: unknown; status: number } = { body: undefined, status: 0 };
  const c = {
    req: { json: vi.fn(async () => body) },
    json: vi.fn((payload: unknown, status = 200) => {
      sent.body = payload;
      sent.status = status;
      return { payload, status };
    }),
  };
  return { c: c as unknown as Context, sent };
}

async function finishStream(body: unknown) {
  const response = { stream: true };
  h.streamSSE.mockReturnValueOnce(response);
  const { c } = context(body);

  await expect(installStream(c)).resolves.toBe(response);
  const callback = h.streamSSE.mock.calls.at(-1)?.[1];
  expect(callback).toBeTypeOf("function");

  const running = callback({
    writeSSE: vi.fn(async () => undefined),
    onAbort: vi.fn(),
  });
  await vi.runAllTimersAsync();
  await running;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  executor.exec.mockResolvedValue("");
  h.withExecutor.mockImplementation(async (_serverId: string, run: (value: unknown) => unknown) =>
    run(executor),
  );
  h.checkComponents.mockImplementation(async (_executor: unknown, names: string[]) =>
    names.map((name) => component(name, true)),
  );
  h.dockerInstaller.mockResolvedValue({ component: "docker", success: true });
  h.edgeInstaller.mockResolvedValue({ component: "edge", success: true });
  h.ensureEdge.mockImplementation(
    async (_executor: unknown, install: (prompt?: unknown) => unknown) => ({
      migrated: false,
      value: await install(undefined),
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("remote server prerequisite checks", () => {
  it("reports Docker missing even when this control plane runs in bare mode", async () => {
    h.checkComponents.mockImplementation(async (_executor: unknown, names: string[]) =>
      names.map((name) =>
        component(name, name !== "docker" && name !== "edge" && name !== "rsync"),
      ),
    );
    const { c, sent } = context({ serverId: "server-1" });

    await checkServer(c);

    expect(h.checkComponents).toHaveBeenCalledWith(executor, ["docker", "git", "edge", "rsync"]);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ ready: false, missing: ["docker"] });
  });

  const denied = () => ({
    ...component("docker", false), installed: true,
    message: "permission denied while connecting to /var/run/docker.sock",
  });

  it("rechecks with the renewed login after supplementary groups change", async () => {
    const fresh = { exec: vi.fn(async () => "") };
    executor.exec.mockResolvedValue("1000\n1000 999\n");
    h.refreshAuthentication.mockResolvedValueOnce(fresh);
    h.withExecutor
      .mockImplementationOnce(async (_id, run) => run(executor))
      .mockImplementationOnce(async (_id, run) => run(fresh));
    h.checkComponents.mockImplementation(async (target) =>
      target === executor ? [denied()] : [component("docker", true)],
    );
    const { c, sent } = context({ serverId: "server-1", components: ["docker"] });
    await checkServer(c);
    expect(h.refreshAuthentication).toHaveBeenCalledWith("server-1", executor);
    expect(h.checkComponents).toHaveBeenLastCalledWith(fresh, ["docker"]);
    expect(sent.body).toMatchObject({ ready: true, missing: [] });
  });

  it("does not reconnect for an actual permission error with unchanged groups", async () => {
    executor.exec.mockResolvedValue("1000\n1000\n");
    h.checkComponents.mockResolvedValue([denied()]);
    const { c, sent } = context({ serverId: "server-1", components: ["docker"] });
    await checkServer(c);
    expect(h.refreshAuthentication).not.toHaveBeenCalled();
    expect(sent.body).toMatchObject({ ready: false, missing: ["docker"] });
  });

  it("keeps the failure if a fresh login still cannot use Docker, without retrying again", async () => {
    const fresh = { exec: vi.fn(async () => "") };
    executor.exec.mockResolvedValue("1000\n1000 999\n");
    h.refreshAuthentication.mockResolvedValueOnce(fresh);
    h.withExecutor
      .mockImplementationOnce(async (_id, run) => run(executor))
      .mockImplementationOnce(async (_id, run) => run(fresh));
    h.checkComponents.mockResolvedValue([denied()]);
    const { c, sent } = context({ serverId: "server-1", components: ["docker"] });
    await checkServer(c);
    expect(h.refreshAuthentication).toHaveBeenCalledTimes(1);
    expect(h.checkComponents).toHaveBeenCalledTimes(2);
    expect(sent.body).toMatchObject({ ready: false, missing: ["docker"] });
  });

  it("explains the required restart when a bare local process cannot renew its login", async () => {
    executor.exec.mockResolvedValue("1000\n1000 999\n");
    h.refreshAuthentication.mockResolvedValueOnce(executor);
    h.checkComponents.mockResolvedValue([denied()]);
    const { c, sent } = context({ serverId: "server-1", components: ["docker"] });
    await checkServer(c);
    expect(sent.body).toMatchObject({
      ready: false,
      components: [expect.objectContaining({ message: expect.stringContaining("Restart Openship") })],
    });
    expect(h.checkComponents).toHaveBeenCalledTimes(1);
  });
});

describe("server component installation dependencies", () => {
  it("orders a reversed Edge + Docker stream as Docker then Edge", async () => {
    await finishStream({ serverId: "server-1", components: ["edge", "docker"] });

    expect(h.dockerInstaller).toHaveBeenCalledTimes(1);
    expect(h.edgeInstaller).toHaveBeenCalledTimes(1);
    expect(h.dockerInstaller.mock.invocationCallOrder[0]).toBeLessThan(
      h.deliverManagedImage.mock.invocationCallOrder[0]!,
    );
    expect(h.deliverManagedImage.mock.invocationCallOrder[0]).toBeLessThan(
      h.edgeInstaller.mock.invocationCallOrder[0]!,
    );
  });

  it("does not reinstall a healthy Docker dependency added for Edge", async () => {
    await finishStream({
      serverId: "server-1",
      components: ["edge"],
      config: { reinstall: true },
    });

    expect(h.checkComponents).toHaveBeenCalledWith(executor, ["docker"]);
    expect(h.dockerInstaller).not.toHaveBeenCalled();
    expect(h.edgeInstaller).toHaveBeenCalledTimes(1);
  });

  it("does not deliver or install Edge when Docker installation fails", async () => {
    h.checkComponents.mockImplementation(async (_executor: unknown, names: string[]) =>
      names.map((name) => component(name, name !== "docker")),
    );
    h.dockerInstaller.mockResolvedValueOnce({
      component: "docker",
      success: false,
      error: "Docker installation failed",
    });

    await finishStream({ serverId: "server-1", components: ["edge"] });

    expect(h.dockerInstaller).toHaveBeenCalledTimes(1);
    expect(h.deliverManagedImage).not.toHaveBeenCalled();
    expect(h.edgeInstaller).not.toHaveBeenCalled();
  });

  it("blocks the single Edge endpoint before image delivery when Docker is unhealthy", async () => {
    h.checkComponents.mockResolvedValueOnce([component("docker", false)]);
    const { c, sent } = context({ serverId: "server-1", component: "edge" });

    await installComponent(c);

    expect(sent.status).toBe(409);
    expect(sent.body).toMatchObject({
      error: "missing_dependency",
      component: "edge",
      missing: ["docker"],
    });
    expect(h.deliverManagedImage).not.toHaveBeenCalled();
    expect(h.edgeInstaller).not.toHaveBeenCalled();
  });
});

// The application seams moved with the shared engine.
vi.mock("@repo/platform/engine/lib/authorization", () => ({
  authorization: { authorize: async (ctx: ExecutionContext, input: PermissionInput) => { await h.assert(ctx, input); return ctx; } },
}));

vi.mock("../../lib/operation-context", () => ({
  operationContext: () => ({ userId: "u1", organizationId: "org1", role: "owner" }),
  operationData: async (_c: unknown, work: Promise<{ data: unknown }>) => (await work).data,
}));
vi.mock("@repo/platform/engine/lib/platform", async () => {
  const { createServerOperations } = await import("@repo/platform");
  const { serverDependencies } = await import("@repo/platform/engine/modules/system/server.operations");
  const { authorization } = await import("@repo/platform/engine/lib/authorization");
  const servers = createServerOperations(authorization, serverDependencies);
  return { getPlatformKernel: () => ({ servers }) };
});
vi.mock("@repo/platform/engine/lib/audit-emitter", () => ({ audit: { recordAsync: vi.fn() }, operationAuditContext: () => ({}) }));

import { OperationError, ValidationError } from "@repo/contracts";
import { handleApiError } from "../../middleware/error-handler";
const checkServer = async (c: Context): Promise<Response> => {
  try { return await checkServerHandler(c); }
  catch (error) {
    if (error instanceof OperationError || error instanceof ValidationError) return handleApiError(error, c);
    throw error;
  }
};
const installComponent = async (c: Context): Promise<Response> => {
  try { return await installComponentHandler(c); }
  catch (error) {
    if (error instanceof OperationError || error instanceof ValidationError) return handleApiError(error, c);
    throw error;
  }
};
