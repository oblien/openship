import { describe, expect, it } from "vitest";
import { shellSplitWords, type ManagedNetworkStepProgress } from "@repo/core";
import { managedOperationFixture } from "../../../contracts/test/managed-network-fixtures";
import { managedNetworkTools, type ManagedHostTransaction } from "./managed-network";
import { PrivateNetworkError } from "./private-network";
import { isRetryableRemoteConnectionError, SshDisconnectedError } from "../system/errors";
import { OS_RELEASE, probeOutput, type ProbeSpec } from "../system/environment.fixtures";
import type { CommandExecutor, LogEntry } from "../types";

const managedId = "a".repeat(32);
const tools = {
  python3: "3.12.3",
  iproute2: "6.1.0",
  "wireguard-tools": "1.0.20210914",
  iptables: "1.8.10",
};
function machine(
  options: {
    versions?: Partial<typeof tools>;
    installed?: Partial<typeof tools>;
    profile?: ProbeSpec;
    kernel?: boolean;
    packageFailure?: boolean;
    commandFailure?: { action: string; error: Error };
  } = {},
) {
  const versions = { ...(options.versions ?? tools) } as Record<string, string | undefined>;
  const commands: string[] = [];
  const installs: string[] = [];
  const updates: Array<{
    id: string;
    status: ManagedNetworkStepProgress["status"];
    message?: string;
  }> = [];
  const logs: LogEntry[] = [];
  const executor = {
    async exec(command: string) {
      commands.push(command);
      if (command.includes("opsh_begin"))
        return probeOutput({ osRelease: OS_RELEASE.ubuntu2404, ...options.profile });
      if (options.commandFailure && command.includes(`'${options.commandFailure.action}'`))
        throw options.commandFailure.error;
      for (const name of Object.keys(tools)) {
        const check =
          name === "python3"
            ? "python3 --version"
            : name === "iproute2"
              ? "ip -Version"
              : name === "iptables"
                ? "iptables --version"
                : "wg --version";
        if (command.includes(check)) {
          const version = versions[name];
          if (!version) throw new Error(`${name}: command not found`);
          return name === "python3"
            ? `Python ${version}`
            : name === "iproute2"
              ? `ip utility, iproute2-${version}, libbpf 1.1.0`
              : name === "iptables"
                ? `iptables v${version} (nf_tables)`
                : `wireguard-tools v${version}`;
        }
      }
      if (command === "iptables -m conntrack --help") return "conntrack match options";
      if (command.includes("'prerequisites'")) {
        expect(versions.python3).toBeTruthy();
        expect(versions.iproute2).toBeTruthy();
        expect(versions["wireguard-tools"]).toBeTruthy();
        return JSON.stringify(
          options.kernel === false
            ? {
                error:
                  "This kernel does not provide WireGuard. Install kernel support and reboot if required.",
              }
            : { ready: true },
        );
      }
      throw new Error(`Unexpected command: ${command.slice(0, 80)}`);
    },
    async streamExec(
      command: string,
      onLog: (entry: LogEntry) => void,
      opts?: { signal?: AbortSignal },
    ) {
      opts?.signal?.throwIfAborted();
      installs.push(command);
      onLog({
        timestamp: new Date().toISOString(),
        level: options.packageFailure ? "error" : "info",
        message: options.packageFailure
          ? "Package repository is unavailable"
          : "Package installation output",
      });
      if (options.packageFailure) return { code: 100, output: "Package repository is unavailable" };
      for (const name of Object.keys(tools))
        if (command.includes(name))
          versions[name] =
            options.installed?.[name as keyof typeof tools] ?? tools[name as keyof typeof tools];
      return { code: 0, output: "" };
    },
  } as unknown as CommandExecutor;
  const observer = {
    step: async (id: string, status: ManagedNetworkStepProgress["status"], message?: string) => {
      updates.push({ id, status, message });
    },
    log: (_id: string, entry: LogEntry) => {
      logs.push(entry);
    },
  };
  return { executor, observer, commands, installs, updates, logs };
}

describe("managed network prerequisite bootstrap", () => {
  it("installs the stateful firewall tool only when a connection policy needs it", async () => {
    const { iptables: _missing, ...versions } = tools;
    const host = machine({ versions });
    await managedNetworkTools.prepareHost(host.executor, managedId, host.observer, undefined, true);
    expect(host.installs).toHaveLength(1);
    expect(host.installs[0]).toContain("--no-install-recommends iptables");
    expect(host.commands).toContain("iptables -m conntrack --help");
    expect(host.updates).toContainEqual(
      expect.objectContaining({ id: "firewall", status: "completed" }),
    );
  });

  it("reuses a healthy stateful firewall without reinstalling it", async () => {
    const host = machine();
    await managedNetworkTools.prepareHost(host.executor, managedId, host.observer, undefined, true);
    expect(host.installs).toEqual([]);
    expect(host.commands).toContain("iptables -m conntrack --help");
  });

  it("passes the firewall prerequisite when the network needs no additional firewall tools", async () => {
    const { iptables: _missing, ...versions } = tools;
    const host = machine({ versions });
    await managedNetworkTools.prepareHost(host.executor, managedId, host.observer);
    expect(host.installs).toEqual([]);
    expect(host.commands).not.toContain("iptables -m conntrack --help");
    expect(host.updates).toContainEqual({
      id: "firewall",
      status: "completed",
      message: "The existing full-mesh policy does not need additional firewall tools.",
    });
  });

  it("installs absent tools before invoking the Python inspector and streams each step", async () => {
    const host = machine({ versions: {} });
    await managedNetworkTools.prepareHost(host.executor, managedId, host.observer);
    expect(host.installs).toHaveLength(3);
    expect(host.installs[0]).toContain("python3");
    expect(host.installs[1]).toContain("iproute2");
    expect(host.installs[2]).toContain("--no-install-recommends wireguard-tools");
    expect(
      host.updates.filter((step) => step.status === "completed").map((step) => step.id),
    ).toEqual(["host", "python3", "iproute2", "wireguard-tools", "firewall", "kernel"]);
    expect(host.logs.some((entry) => entry.message === "Package installation output")).toBe(true);
  });
  it("reuses healthy tools without invoking a package installer", async () => {
    const host = machine();
    await managedNetworkTools.prepareHost(host.executor, managedId, host.observer);
    expect(host.installs).toEqual([]);
    expect(host.updates.at(-1)).toMatchObject({ id: "kernel", status: "completed" });
  });
  it("refuses an outdated Python package and does not continue into networking", async () => {
    const host = machine({
      versions: { ...tools, python3: "3.7.9" },
      installed: { python3: "3.7.9" },
    });
    await expect(
      managedNetworkTools.prepareHost(host.executor, managedId, host.observer),
    ).rejects.toThrow("3.8 or newer");
    expect(host.updates.at(-1)).toMatchObject({ id: "python3", status: "failed" });
    expect(host.installs).toHaveLength(1);
    expect(host.commands.some((command) => command.includes("'prerequisites'"))).toBe(false);
  });
  it.each([
    { sm: "openrc" },
    { uid: "1000", user: "deploy", home: "/home/deploy", sudo: "n" },
    { fw: "ufw" },
  ] as ProbeSpec[])(
    "rejects an incompatible host before installing packages: %j",
    async (profile) => {
      const host = machine({ versions: {}, profile });
      await expect(
        managedNetworkTools.prepareHost(host.executor, managedId, host.observer),
      ).rejects.toThrow();
      expect(host.installs).toEqual([]);
      expect(host.updates.at(-1)).toMatchObject({ id: "host", status: "failed" });
    },
  );
  it("elevates package installation for a passwordless sudo login", async () => {
    const host = machine({
      versions: {},
      profile: { uid: "1000", user: "deploy", home: "/home/deploy", sudo: "y" },
    });
    await managedNetworkTools.prepareHost(host.executor, managedId, host.observer);
    expect(host.installs).toHaveLength(3);
    expect(host.installs.every((command) => command.includes("sudo -n sh -c"))).toBe(true);
  });
  it("keeps repository errors in the live log and fails the current dependency", async () => {
    const host = machine({ versions: {}, packageFailure: true });
    await expect(
      managedNetworkTools.prepareHost(host.executor, managedId, host.observer),
    ).rejects.toThrow("exit code 100");
    expect(host.updates.at(-1)).toMatchObject({ id: "python3", status: "failed" });
    expect(host.logs.some((entry) => entry.message.includes("repository is unavailable"))).toBe(
      true,
    );
    expect(host.installs).toHaveLength(1);
  });
  it("reports kernel support separately instead of attempting a kernel replacement", async () => {
    const host = machine({ kernel: false });
    await expect(
      managedNetworkTools.prepareHost(host.executor, managedId, host.observer),
    ).rejects.toThrow("kernel does not provide");
    expect(host.updates.at(-1)).toMatchObject({ id: "kernel", status: "failed" });
    expect(host.installs).toEqual([]);
  });
});

describe("managed connection-policy payloads", () => {
  it("keeps selected WireGuard peers and protects the complete subnet from default-route fallback", async () => {
    const operation = managedOperationFixture(["server-a", "server-b", "server-c"]);
    const config = operation.plan.config;
    config.network.access = {
      version: 1,
      rules: [{ sourceServerId: "server-a", targetServerId: "server-b" }],
    };
    config.members.forEach(
      (member, index) => (member.publicKey = Buffer.alloc(32, index + 1).toString("base64")),
    );
    const host = machine();
    const payloads: Array<{
      config: {
        peers: Array<{ serverId: string }>;
        routeCidrs: string[];
        firewall: { up: string[]; snapshot: string };
      };
    }> = [];
    const executor = {
      ...host.executor,
      exec: async (command: string) => {
        if (!command.includes("'apply'")) return host.executor.exec(command);
        const payload = JSON.parse(shellSplitWords(command).at(-1)!);
        payloads.push(payload);
        return JSON.stringify({
          operationId: operation.id,
          generation: 1,
          stage: "applied",
          publicKey: null,
          configHash: null,
          deadline: Date.now() / 1000 + 60,
          healthy: true,
        });
      },
    };
    for (const planned of operation.plan.hosts)
      await managedNetworkTools.apply(
        executor,
        {
          managedId: operation.plan.managedId,
          operationId: operation.id,
          generation: 1,
          host: planned,
          accessControlled: true,
        },
        config,
      );
    expect(payloads.map((payload) => payload.config.peers.map((peer) => peer.serverId))).toEqual([
      ["server-b"],
      ["server-a"],
      [],
    ]);
    for (const payload of payloads) {
      expect(payload.config.routeCidrs).toEqual(config.network.cidrs);
      expect(payload.config.firewall.snapshot).toContain("python3");
      expect(payload.config.firewall.up.join("\n")).toContain("-j DROP");
      if (payload.config.peers.length)
        expect(payload.config.firewall.up.join("\n")).toContain("--ctdir");
    }
  });
  it("checks an isolated interface without requiring a nonexistent handshake", async () => {
    const host = machine();
    let reported = { ready: true, interfaceReady: true, peers: [] as unknown[] };
    const executor = {
      ...host.executor,
      exec: async (command: string) =>
        command.includes("'ready'") ? JSON.stringify(reported) : host.executor.exec(command),
    };
    await expect(managedNetworkTools.waitForPeers(executor, managedId, [])).resolves.toEqual(
      reported,
    );
    reported = { ...reported, peers: [{ serverId: "unexpected" }] };
    await expect(managedNetworkTools.inspectPeers(executor, managedId, [])).rejects.toMatchObject({
      code: "MANAGED_NETWORK_REPORT_INVALID",
    });
  });
});

describe("managed network command failures", () => {
  const identity = {
    managedId,
    hostIdentity: "host:server-a",
    endpoint: "192.0.2.10",
    listenPort: 51820,
  };
  it("preserves the host's detailed, bounded diagnostic beyond the old 512-character cutoff", async () => {
    const host = machine();
    const message = `Inspect host firewall rules failed (exit 1): ${"context ".repeat(90)}iptables-save: Permission denied`;
    const executor = {
      ...host.executor,
      exec: async (command: string) =>
        command.includes("'inspect'")
          ? JSON.stringify({ error: message, code: "MANAGED_NETWORK_COMMAND_FAILED" })
          : host.executor.exec(command),
    };
    await expect(managedNetworkTools.inspect(executor, identity)).rejects.toMatchObject({
      code: "MANAGED_NETWORK_COMMAND_FAILED",
      message,
    });
  });
  it.each([
    [
      new SshDisconnectedError("transport-private-detail"),
      "MANAGED_NETWORK_HOST_UNREACHABLE",
      "lost its SSH connection",
    ],
    [
      new Error("Command timed out after 60000ms: python3 -c private-command-input"),
      "MANAGED_NETWORK_COMMAND_TIMEOUT",
      "within 60 seconds",
    ],
    [
      new Error("Timed out while waiting for handshake: private-transport-detail"),
      "MANAGED_NETWORK_CONNECTION_TIMEOUT",
      "connection timed out",
    ],
    [
      new Error("All configured authentication methods failed: private-auth-detail"),
      "MANAGED_NETWORK_AUTH_FAILED",
      "authentication was rejected",
    ],
    [
      new Error("EACCES: private-path"),
      "MANAGED_NETWORK_PERMISSION_DENIED",
      "permissions were denied",
    ],
    [
      new Error("ECONNREFUSED: private-address"),
      "MANAGED_NETWORK_HOST_UNREACHABLE",
      "could not reach the server",
    ],
    [new Error("Unable to exec"), "MANAGED_NETWORK_HOST_UNREACHABLE", "SSH command exchange"],
    [
      new Error("Exit code 1: private-command-output"),
      "MANAGED_NETWORK_COMMAND_FAILED",
      "failed while running the host command",
    ],
  ])(
    "classifies inspection failure without exposing executor output: %s",
    async (cause, code, detail) => {
      const host = machine({ commandFailure: { action: "inspect", error: cause } });
      const failure = await managedNetworkTools
        .inspect(host.executor, identity)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PrivateNetworkError);
      expect(failure).toMatchObject({ code, cause, message: expect.stringContaining(detail) });
      expect((failure as Error).message).toContain("Network inspection");
      expect((failure as Error).message).toContain("does not change network configuration");
      expect((failure as Error).message).not.toMatch(/rollback|private-/);
      expect(JSON.stringify(failure)).not.toContain("private-");
      expect(host.installs).toEqual([]);
    },
  );
  it("reports a prerequisite command failure at the kernel check", async () => {
    const host = machine({
      commandFailure: { action: "prerequisites", error: new Error("Exit code 1") },
    });
    await expect(
      managedNetworkTools.prepareHost(host.executor, managedId, host.observer),
    ).rejects.toMatchObject({
      code: "MANAGED_NETWORK_COMMAND_FAILED",
      message: expect.stringContaining("Network prerequisite check"),
    });
    expect(host.updates.at(-1)).toMatchObject({ id: "kernel", status: "failed" });
    expect(host.updates.at(-1)?.message).not.toContain("rollback");
  });
  it("keeps an uncertain network change in recovery without making its wrapper globally retryable", async () => {
    const cause = new SshDisconnectedError("private-transport-detail");
    const host = machine({ commandFailure: { action: "rollback", error: cause } });
    const transaction: ManagedHostTransaction = {
      managedId,
      operationId: "aaaaaaaa-1111-4111-8111-111111111111",
      generation: 1,
      host: {
        serverId: "server-a",
        name: "Server A",
        hostIdentity: identity.hostIdentity,
        fingerprint: "a".repeat(64),
        configHash: null,
        endpoint: identity.endpoint,
        listenPort: identity.listenPort,
        privateIp: "10.244.0.1",
        packages: [],
        firewall: "none",
        action: "configure",
      },
    };
    const failure = await managedNetworkTools
      .rollback(host.executor, transaction)
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({
      cause,
      message: expect.stringContaining("result is unconfirmed"),
    });
    expect((failure as Error).message).not.toMatch(/timer|does not change/);
    expect(isRetryableRemoteConnectionError(failure)).toBe(false);
    expect(host.commands.filter((command) => command.includes("'rollback'"))).toHaveLength(1);
  });
});
