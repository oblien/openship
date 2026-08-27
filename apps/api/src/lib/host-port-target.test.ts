import { describe, expect, it, vi } from "vitest";

import type { CommandExecutor } from "@repo/adapters";

import {
  LOCAL_HOST_PORT_TARGET,
  normalizeHostPortConnectionLocator,
  normalizeTargetHostId,
  normalizeTargetMachineId,
  resolveHostPortTargetIdentity,
} from "./host-port-target";

function executorWithFiles(files: Record<string, string | Error>): CommandExecutor {
  return {
    readFile: vi.fn(async (path: string) => {
      const value = files[path];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error("missing");
      return value;
    }),
  } as unknown as CommandExecutor;
}

const connection = {
  sshHost: "Deploy.Example.COM.",
  sshPort: 22,
  sshJumpHost: "Jump.Example.COM.",
  sshArgs: "  -o   ProxyCommand=none  ",
};

describe("host-port target identity", () => {
  it("validates OS and OpenShip target ids before trusting them", () => {
    expect(normalizeTargetMachineId("0123456789ABCDEF0123456789ABCDEF\n")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    expect(normalizeTargetMachineId("0".repeat(32))).toBeNull();
    expect(normalizeTargetMachineId("uninitialized")).toBeNull();
    expect(normalizeTargetHostId("550E8400-E29B-41D4-A716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
    expect(normalizeTargetHostId("../../another-host")).toBeNull();
  });

  it("collapses different server rows reaching the same target-issued machine id", async () => {
    const files = { "/etc/machine-id": "0123456789abcdef0123456789abcdef\n" };
    const first = await resolveHostPortTargetIdentity({
      localHost: false,
      serverId: "server-one",
      executor: executorWithFiles(files),
      connection,
    });
    const second = await resolveHostPortTargetIdentity({
      localHost: false,
      serverId: "server-two",
      executor: executorWithFiles(files),
      connection: { ...connection, sshHost: "an-alias.example.com" },
    });

    expect(first.targetKey).toMatch(/^host:[0-9a-f]{64}$/);
    expect(second.targetKey).toBe(first.targetKey);
    expect(first.stable).toBe(true);
    expect(first.legacyTargetKeys).toEqual(["server:server-one"]);
    expect(second.legacyTargetKeys).toEqual(["server:server-two"]);
  });

  it("uses an existing OpenShip host id when machine-id is unavailable", async () => {
    const result = await resolveHostPortTargetIdentity({
      localHost: false,
      serverId: "server-one",
      executor: executorWithFiles({
        "/etc/machine-id": new Error("unreadable"),
        "/var/lib/openship/host-id": "550e8400-e29b-41d4-a716-446655440000\n",
      }),
      connection,
    });

    expect(result.targetKey).toMatch(/^host:[0-9a-f]{64}$/);
    expect(result.stable).toBe(true);
  });

  it("normalizes a credential-free connection locator only as a last resort", async () => {
    expect(normalizeHostPortConnectionLocator(connection)).toBe(
      "ssh://deploy.example.com:22?jump=jump.example.com&args=-o%20ProxyCommand%3Dnone",
    );
    const first = await resolveHostPortTargetIdentity({
      localHost: false,
      serverId: "one",
      executor: executorWithFiles({
        "/etc/machine-id": "invalid",
        "/var/lib/openship/host-id": "invalid",
      }),
      connection,
    });
    const second = await resolveHostPortTargetIdentity({
      localHost: false,
      serverId: "two",
      executor: executorWithFiles({}),
      connection: {
        sshHost: "deploy.example.com",
        sshPort: null,
        sshJumpHost: "jump.example.com",
        sshArgs: "-o ProxyCommand=none",
      },
    });

    expect(second.targetKey).toBe(first.targetKey);
    expect(first.stable).toBe(false);
    expect(second.stable).toBe(false);
  });

  it("atomically creates a stable OpenShip host id before using the locator fallback", async () => {
    const executor = executorWithFiles({
      "/etc/machine-id": new Error("missing"),
      "/var/lib/openship/host-id": new Error("missing"),
    });
    executor.exec = vi.fn(async () => "550e8400-e29b-41d4-a716-446655440000\n");

    const result = await resolveHostPortTargetIdentity({
      localHost: false,
      serverId: "server-one",
      executor,
      connection,
    });

    expect(result.stable).toBe(true);
    expect(result.targetKey).toMatch(/^host:[0-9a-f]{64}$/);
    expect(executor.exec).toHaveBeenCalledTimes(1);
  });

  it("keeps all local and isLocal paths in the local collision domain", async () => {
    const executor = executorWithFiles({});
    const result = await resolveHostPortTargetIdentity({
      localHost: true,
      serverId: "this-server-row",
      executor,
      connection,
    });

    expect(result).toBe(LOCAL_HOST_PORT_TARGET);
    expect(executor.readFile).not.toHaveBeenCalled();
  });
});
