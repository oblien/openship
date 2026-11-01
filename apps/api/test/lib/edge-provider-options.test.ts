import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  server: vi.fn(),
  advisory: vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn()),
  env: { CLOUD_MODE: false },
  acme: {
    acmeEmail: "operator@example.com",
    acmeDirectoryUrl: "https://private-ca.example/acme",
    acmeEabKid: "operator-account",
    acmeEabHmacKey: "operator-secret",
    acmeCaBundle: "/etc/operator-ca.pem",
  },
}));
vi.mock("@repo/platform/engine/config/env", () => ({ env: h.env }));
vi.mock("@repo/db", () => ({
  repos: { server: { get: h.server } },
  withAdvisoryLock: h.advisory,
}));
vi.mock("@repo/platform/engine/lib/acme-config", () => ({
  resolveAcmeProviderOptions: () => h.acme,
}));
vi.mock("@repo/platform/engine/lib/box-org", () => ({
  isLocalHostRow: async (server: { isLocal: boolean }) => server.isLocal,
}));

import {
  edgeProviderOptions,
  resolveEdgeProviderOptions,
} from "@repo/platform/engine/lib/edge-provider-options";

beforeEach(() => {
  vi.clearAllMocks();
  h.env.CLOUD_MODE = false;
});

it("does not pass SaaS operator certificate credentials or configuration to customer hosts", async () => {
  h.env.CLOUD_MODE = true;
  const server = { id: "srv_customer", isLocal: false };
  h.server.mockResolvedValue(server);
  for (const options of [
    edgeProviderOptions(server.id),
    await resolveEdgeProviderOptions(server.id),
    await resolveEdgeProviderOptions(server as never),
  ]) {
    expect(Object.keys(options)).toEqual(["configLock"]);
    await options.configLock!.run(async () => undefined);
  }
  expect(h.advisory.mock.calls.map(([key]) => key)).toEqual([
    "edge-config:server:srv_customer",
    "edge-config:server:srv_customer",
    "edge-config:server:srv_customer",
  ]);
});

it("preserves operator certificate settings for self-hosted local and remote edges", () => {
  expect(edgeProviderOptions()).toMatchObject(h.acme);
  expect(edgeProviderOptions("srv_remote")).toMatchObject(h.acme);
});

it("uses the same lock for the local platform and its This Server alias", async () => {
  h.server.mockResolvedValue({ id: "srv_local", isLocal: true });
  const local = edgeProviderOptions();
  const alias = await resolveEdgeProviderOptions("srv_local");
  expect(alias.acmeEmail).toBe("operator@example.com");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const first = local.configLock!.run(async () => {
    events.push("first");
    await pending;
  });
  const second = alias.configLock!.run(async () => {
    events.push("second");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(events).toEqual(["first"]);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(["first", "second"]);
  expect(h.advisory.mock.calls.map(([key]) => key)).toEqual([
    "edge-config:local",
    "edge-config:local",
  ]);
});

it("shares the remote server key with deployments and does not block unrelated edges", async () => {
  h.server.mockResolvedValue({ id: "srv_remote", isLocal: false });
  const remote = await resolveEdgeProviderOptions("srv_remote");
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: string[] = [];
  const first = edgeProviderOptions("srv_remote").configLock!.run(async () => {
    await pending;
  });
  const second = remote.configLock!.run(async () => {
    events.push("same");
  });
  await edgeProviderOptions("srv_other").configLock!.run(async () => {
    events.push("other");
  });
  expect(events).toEqual(["other"]);
  release();
  await Promise.all([first, second]);
  expect(events).toEqual(["other", "same"]);
  expect(h.advisory.mock.calls.map(([key]) => key)).toEqual([
    "edge-config:server:srv_remote",
    "edge-config:server:srv_other",
    "edge-config:server:srv_remote",
  ]);
});

it("does not fall back to a local edge for a deleted server", async () => {
  h.server.mockResolvedValue(undefined);
  await expect(resolveEdgeProviderOptions("missing")).rejects.toThrow("Server not found");
  expect(h.advisory).not.toHaveBeenCalled();
});

it("reuses the authorized server row without an additional unscoped lookup", async () => {
  const options = await resolveEdgeProviderOptions({ id: "srv_setup", isLocal: false } as never);
  await options.configLock!.run(async () => undefined);
  expect(h.server).not.toHaveBeenCalled();
  expect(h.advisory).toHaveBeenCalledWith("edge-config:server:srv_setup", expect.any(Function));
});
