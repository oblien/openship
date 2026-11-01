/**
 * Real WireGuard lifecycle checks in disposable Linux/systemd containers.
 * bun packages/adapters/scripts/verify-managed-network.ts <docker-context>
 * Requires a Linux Docker VM with WireGuard support. No host mounts or published
 * ports; privileged containers are isolated fixtures and removed in finally.
 */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { managedNetworkTools, type ManagedHostTransaction } from "../src/network/managed-network";
import { privateNetworkTools, type PrivateNetworkProbe } from "../src/network/private-network";
import {
  allocateManagedSubnet,
  allocateManagedAddresses,
  managedInterfaceName,
  type WireGuardClusterConfig,
} from "@repo/core";
import type { CommandExecutor } from "../src/types";

const context = process.argv[2];
if (!context) throw new Error("Supply a Docker context for the disposable Linux fixtures.");
const exec = promisify(execFile);
const docker = async (args: string[], timeout = 60_000) =>
  (await exec("docker", ["--context", context, ...args], { timeout, maxBuffer: 8 * 1024 * 1024 }))
    .stdout;
const suffix = randomBytes(5).toString("hex");
const image = `openship-managed-network-test:${suffix}`;
const network = `openship-managed-network-${suffix}`;
const names = ["a", "b", "c"].map((name) => `openship-wg-${name}-${suffix}`);
const build = await mkdtemp(join(tmpdir(), "openship-managed-network-"));
const managedId = randomBytes(16).toString("hex");
const interfaceName = managedInterfaceName(managedId);
const stateDir = `/root/.openship/networks/${managedId}`;
const executors = names.map(
  (name) =>
    ({
      exec: (command: string, opts?: { timeout?: number }) =>
        docker(["exec", name, "sh", "-c", command], opts?.timeout),
      streamExec: (
        command: string,
        onLog: (entry: { timestamp: string; message: string; level: "info" | "error" }) => void,
        opts?: { signal?: AbortSignal },
      ) =>
        new Promise<{ code: number; output: string }>((resolve, reject) => {
          const child = spawn("docker", ["--context", context, "exec", name, "sh", "-c", command], {
            signal: opts?.signal,
          });
          let output = "";
          const line = (level: "info" | "error") => (chunk: Buffer) => {
            const message = chunk.toString();
            output += message;
            onLog({ timestamp: new Date().toISOString(), level, message });
          };
          child.stdout.on("data", line("info"));
          child.stderr.on("data", line("error"));
          child.on("error", reject);
          child.on("close", (code) => resolve({ code: code ?? 1, output }));
        }),
    }) as CommandExecutor,
);
const endpoints = names.map((_, i) => `10.253.247.${i + 2}`);
const completed: string[] = [];
const passed = (message: string) => {
  completed.push(message);
  console.log(`PASS ${message}`);
};
async function systemdReady(name: string) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const state = await docker([
      "exec",
      name,
      "sh",
      "-c",
      "systemctl is-system-running 2>/dev/null || true",
    ]);
    if (/running|degraded/.test(state)) return;
    await delay(200);
  }
  throw new Error(
    `systemd did not start in ${name}: ${await docker(["exec", name, "systemctl", "list-jobs", "--no-pager"])} ${await docker(["exec", name, "journalctl", "-u", `openship-network-${managedId}.service`, "--no-pager", "-n", "20"])}`,
  );
}
try {
  // Docker configures eth0 before PID 1; networkd's DHCP wait has no role here.
  await writeFile(
    join(build, "Dockerfile"),
    'FROM ubuntu:24.04\nENV DEBIAN_FRONTEND=noninteractive\nRUN apt-get update -qq && apt-get install -y -qq systemd systemd-sysv dbus python3 iproute2 iptables wireguard-tools && rm -rf /var/lib/apt/lists/*\nRUN apt-get update -qq && apt-get install -y -qq iptables-persistent && rm -rf /var/lib/apt/lists/*\nRUN rm -f /etc/machine-id /var/lib/dbus/machine-id && systemctl mask systemd-networkd-wait-online.service\nSTOPSIGNAL SIGRTMIN+3\nCMD ["/sbin/init"]\n',
  );
  console.log("Building Linux/systemd fixtures…");
  await docker(["build", "-q", "-t", image, build], 240_000);
  // Egress is needed only for distribution package repositories; nothing is published.
  await docker(["network", "create", "--subnet", "10.253.247.0/24", network]);
  for (const [i, name] of names.entries()) {
    await docker([
      "run",
      "-d",
      "--name",
      name,
      "--privileged",
      "--cgroupns=private",
      "--tmpfs",
      "/run",
      "--tmpfs",
      "/run/lock",
      "--network",
      network,
      "--ip",
      endpoints[i]!,
      image,
    ]);
    await systemdReady(name);
    await docker(["exec", name, "ip", "link", "add", "wg-kernel-test", "type", "wireguard"]);
    await docker(["exec", name, "ip", "link", "del", "wg-kernel-test"]);
  }
  // The stock nftables startup flushes Docker's embedded DNS redirects inside
  // this disposable namespace. Give the package test its own reachable resolver.
  await docker(["exec", names[0]!, "sh", "-c", "printf 'nameserver 1.1.1.1\n' > /etc/resolv.conf"]);
  await docker(["exec", names[0]!, "timeout", "20", "getent", "ahostsv4", "ports.ubuntu.com"]);
  // Prove the actual cold-host bootstrap, rather than hiding the dependency gap
  // inside the test image. Kernel support was loaded above by the fixture only.
  await docker(
    [
      "exec",
      names[0]!,
      "sh",
      "-c",
      "apt-get purge -y -qq python3 python3-minimal iproute2 wireguard-tools",
    ],
    180_000,
  );
  const before = await docker([
    "exec",
    names[0]!,
    "sh",
    "-c",
    "command -v python3 || true; command -v ip || true; command -v wg || true",
  ]);
  assert.equal(before.trim(), "");
  const bootstrapped: string[] = [];
  let packageLogs = 0;
  const packageOutput: string[] = [];
  await managedNetworkTools
    .prepareHost(
      executors[0]!,
      managedId,
      {
        step: async (step, status) => {
          if (status === "completed") bootstrapped.push(step);
        },
        log: (_step, entry) => {
          packageLogs++;
          packageOutput.push(entry.message);
        },
      },
      AbortSignal.timeout(300_000),
    )
    .catch((error) => {
      console.error(packageOutput.join("\n").slice(-8000));
      throw error;
    });
  assert.deepEqual(bootstrapped, ["host", "python3", "iproute2", "wireguard-tools", "kernel"]);
  assert(packageLogs > 0);
  passed(
    "Cold host automatically installs Python, iproute2 and WireGuard through the shared toolchain",
  );
  let repeatedInstall = false;
  await managedNetworkTools.prepareHost(executors[0]!, managedId, {
    step: async () => {},
    log: (step, entry) => {
      if (entry.message.startsWith("Installing")) repeatedInstall = true;
    },
  });
  assert.equal(repeatedInstall, false);
  passed("Repeated preparation verifies healthy tools without reinstalling packages");
  await docker([
    "exec",
    names[0]!,
    "sh",
    "-c",
    "printf '#!/bin/sh\nexit 1\n' > /usr/local/bin/docker && chmod 755 /usr/local/bin/docker",
  ]);
  await assert.rejects(
    managedNetworkTools.inspect(executors[0]!, {
      managedId,
      hostIdentity: names[0]!,
      endpoint: endpoints[0]!,
      listenPort: 51820,
    }),
    /docker network ls -q failed \(exit \d+\)/,
  );
  await docker(["exec", names[0]!, "rm", "/usr/local/bin/docker"]);
  passed("An inaccessible Docker daemon blocks range inspection with an actionable error");
  // One mesh across the supported firewall matrix, with existing SSH rules kept.
  for (const name of names.slice(1)) {
    await docker(["exec", name, "systemctl", "disable", "--now", "nftables.service"]);
  }
  await docker([
    "exec",
    names[2]!,
    "iptables",
    "-A",
    "INPUT",
    "-p",
    "tcp",
    "--dport",
    "22",
    "-j",
    "ACCEPT",
  ]);
  await docker(["exec", names[2]!, "iptables", "-A", "INPUT", "-i", "lo", "-j", "ACCEPT"]);
  await docker(["exec", names[2]!, "iptables", "-P", "INPUT", "DROP"]);
  await docker(["exec", names[2]!, "netfilter-persistent", "save"]);
  const inspect = () =>
    Promise.all(
      executors.map((executor, i) =>
        managedNetworkTools.inspect(executor, {
          managedId,
          hostIdentity: names[i]!,
          endpoint: endpoints[i]!,
          listenPort: 51820,
          transportEndpoints: endpoints.filter((_, j) => i !== j),
        }),
      ),
    );
  let observations = await inspect();
  assert.deepEqual(
    observations.map((host) => host.firewall),
    ["nftables", "none", "iptables"],
  );
  assert(observations.every((host) => host.configHash === null && host.publicKey === null));
  for (const name of names)
    assert.equal(
      (await docker(["exec", name, "sh", "-c", `test ! -e ${stateDir} && echo absent`])).trim(),
      "absent",
    );
  passed("Read-only planning creates no keys, interfaces or host state");
  await docker(["exec", names[0]!, "ip", "link", "add", interfaceName, "type", "wireguard"]);
  try {
    await assert.rejects(managedNetworkTools.inspect(executors[0]!, {
      managedId, hostIdentity: names[0]!, endpoint: endpoints[0]!, listenPort: 51820,
    }), /without an OpenShip ownership receipt/);
  } finally {
    await docker(["exec", names[0]!, "ip", "link", "delete", interfaceName]);
  }
  passed("Planning refuses an existing interface without a receipt even when it has no IPv4 address");
  const cidr = allocateManagedSubnet(observations);
  const addresses = allocateManagedAddresses(cidr, names);
  let config: WireGuardClusterConfig = {
    name: "Lifecycle fixture",
    network: {
      mode: "wireguard",
      managedId,
      interfaceName,
      cidrs: [cidr],
      mtu: 1400,
      probePort: 45876,
    },
    members: names.map((name, i) => ({
      serverId: name,
      providerId: "custom",
      privateIp: addresses.get(name)!,
      endpoint: endpoints[i]!,
      listenPort: 51820,
      interfaceName,
    })),
  };
  function transactions(operationId = randomUUID(), generation = 1): ManagedHostTransaction[] {
    return names.map((name, i) => ({
      managedId,
      operationId,
      generation,
      host: {
        serverId: name,
        name,
        hostIdentity: name,
        fingerprint: observations[i]!.fingerprint,
        configHash: observations[i]!.configHash,
        endpoint: endpoints[i]!,
        listenPort: 51820,
        privateIp: addresses.get(name)!,
        packages: observations[i]!.packages,
        firewall: observations[i]!.firewall,
        action: "configure",
      },
    }));
  }
  async function prepare(tx: ManagedHostTransaction[], rotate = false) {
    const results = await Promise.all(
      executors.map((executor, i) => managedNetworkTools.prepare(executor, tx[i]!, rotate)),
    );
    config = {
      ...config,
      members: config.members.map((member) => ({
        ...member,
        publicKey: results[names.indexOf(member.serverId)]!.publicKey!,
      })),
    };
    return results;
  }
  async function apply(tx: ManagedHostTransaction[]) {
    const selected = config.members.map((member) => names.indexOf(member.serverId));
    await Promise.all(
      selected.map((i) => managedNetworkTools.stageTransport(executors[i]!, tx[i]!, config)),
    );
    const interfaces = await Promise.all(
      selected.map(async (i) => {
        const links = JSON.parse(
          await docker(["exec", names[i]!, "ip", "-j", "addr", "show", "dev", interfaceName]),
        );
        assert.deepEqual(
          links[0].addr_info,
          [],
          "Transport must not assign private addresses before handshakes",
        );
        assert.equal(
          (
            await managedNetworkTools.waitForPeers(
              executors[i]!,
              managedId,
              config.members
                .filter((peer) => peer.serverId !== names[i])
                .map((peer) => peer.serverId),
            )
          ).ready,
          true,
          "The reviewed UDP endpoints must complete encrypted handshakes before routes",
        );
        return links[0].ifindex;
      }),
    );
    await Promise.all(
      executors.map((executor, i) =>
        managedNetworkTools.apply(
          executor,
          tx[i]!,
          config.members.some((member) => member.serverId === names[i]) ? config : null,
        ),
      ),
    );
    await Promise.all(
      selected.map(async (i, index) => {
        const links = JSON.parse(
          await docker(["exec", names[i]!, "ip", "-j", "link", "show", "dev", interfaceName]),
        );
        assert.equal(
          links[0].ifindex,
          interfaces[index],
          "Route setup must preserve the verified WireGuard interface",
        );
      }),
    );
  }
  async function verify() {
    const members = config.members;
    await Promise.all(
      members.map(async (member) =>
        assert.equal(
          (
            await managedNetworkTools.waitForPeers(
              executors[names.indexOf(member.serverId)]!,
              managedId,
              members
                .filter((peer) => peer.serverId !== member.serverId)
                .map((peer) => peer.serverId),
            )
          ).ready,
          true,
        ),
      ),
    );
    const probes: PrivateNetworkProbe[] = members.map((member) => ({
      serverId: member.serverId,
      privateIp: member.privateIp,
      port: config.network.probePort,
      token: randomBytes(24).toString("hex"),
    }));
    try {
      await Promise.all(
        probes.map((probe) =>
          privateNetworkTools.listen(
            executors[names.indexOf(probe.serverId)]!,
            probe,
            probes.map((other) => other.privateIp),
          ),
        ),
      );
      for (const probe of probes) {
        const checks = await privateNetworkTools.check(
          executors[names.indexOf(probe.serverId)]!,
          probe,
          probes.filter((other) => other !== probe),
          config.network.mtu,
        );
        assert(
          checks.every((check) => check.tcp && check.udp && check.mtu),
          JSON.stringify(checks),
        );
      }
    } finally {
      await Promise.all(
        probes.map((probe) =>
          privateNetworkTools.stop(executors[names.indexOf(probe.serverId)]!, probe),
        ),
      );
    }
  }
  let tx = transactions();
  await prepare(tx);
  for (const name of names) {
    assert.equal(
      (await docker(["exec", name, "stat", "-c", "%a", `${stateDir}/staged.key`])).trim(),
      "600",
    );
    assert.equal(
      (
        await docker([
          "exec",
          name,
          "systemctl",
          "is-enabled",
          `openship-network-${managedId}-rollback.timer`,
        ])
      ).trim(),
      "enabled",
    );
  }
  passed("Host-only keys and persistent rollback timers are ready before network changes");
  await apply(tx);
  await verify();
  passed("Three-member encrypted mesh passes all directed TCP, UDP and MTU probes");
  await docker([
    "exec",
    names[1]!,
    "iptables",
    "-I",
    "INPUT",
    "-p",
    "udp",
    "--dport",
    "51820",
    "-j",
    "DROP",
  ]);
  const blockedProbes = config.members.slice(0, 2).map((member) => ({
    serverId: member.serverId,
    privateIp: member.privateIp,
    port: 45876,
    token: randomBytes(24).toString("hex"),
  }));
  try {
    await privateNetworkTools.listen(
      executors[1]!,
      blockedProbes[1]!,
      blockedProbes.map((probe) => probe.privateIp),
    );
    const [blocked] = await privateNetworkTools.check(
      executors[0]!,
      blockedProbes[0]!,
      [blockedProbes[1]!],
      1400,
    );
    assert(blocked && !blocked.tcp && !blocked.udp && !blocked.mtu);
  } finally {
    await privateNetworkTools.stop(executors[1]!, blockedProbes[1]!);
    await docker([
      "exec",
      names[1]!,
      "iptables",
      "-D",
      "INPUT",
      "-p",
      "udp",
      "--dport",
      "51820",
      "-j",
      "DROP",
    ]);
  }
  passed("Blocked transport UDP fails private verification instead of reporting a healthy tunnel");
  const source = config.members[0]!;
  const peer = config.members[1]!;
  await docker(["exec", names[0]!, "ip", "-4", "route", "del", `${peer.privateIp}/32`, "dev", interfaceName]);
  await assert.rejects(managedNetworkTools.commit(executors[0]!, tx[0]!), /no longer matches the verified network/);
  await docker(["exec", names[0]!, "ip", "-4", "route", "add", `${peer.privateIp}/32`, "dev", interfaceName, "src", source.privateIp]);
  passed("A missing private route prevents commit even when WireGuard keys and handshakes remain healthy");
  await Promise.all(executors.map((executor, i) => managedNetworkTools.commit(executor, tx[i]!)));
  const originalKeys = config.members.map((member) => member.publicKey);
  await Promise.all(names.map((name) => docker(["restart", name])));
  for (const name of names) await systemdReady(name);
  await verify();
  passed("Committed tunnels and routes return after a host reboot without the controller");
  observations = await inspect();
  assert(observations.every((host) => host.configHash && host.publicKey));
  tx = transactions();
  await prepare(tx, true);
  await apply(tx);
  await verify();
  assert(config.members.every((member, i) => member.publicKey !== originalKeys[i]));
  await Promise.all(
    executors.map((executor, i) =>
      managedNetworkTools.rollback(executor, { ...tx[i]!, generation: 2 }),
    ),
  );
  const restored = await inspect();
  assert(restored.every((host, i) => host.publicKey === originalKeys[i]));
  config = {
    ...config,
    members: config.members.map((member, i) => ({ ...member, publicKey: originalKeys[i] })),
  };
  await verify();
  passed("A new controller generation restores the original keys and complete mesh");
  await assert.rejects(managedNetworkTools.apply(executors[0]!, tx[0]!, config), /generation/);
  passed("A stale controller generation cannot reapply after recovery");
  observations = await inspect();
  tx = transactions();
  await prepare(tx, true);
  await apply(tx);
  // Shorten only the disposable hosts' installed deadline; production remains
  // twenty minutes. The actual installed timer/boot units perform the recovery.
  for (const name of names) {
    const script = `import datetime,json,pathlib,time\nb=pathlib.Path('${stateDir}'); p=b/'receipt.json'; r=json.loads(p.read_text()); r['deadline']=int(time.time())+8; p.write_text(json.dumps(r))\nt=pathlib.Path('/etc/systemd/system/openship-network-${managedId}-rollback.timer'); lines=t.read_text().splitlines(); deadline=datetime.datetime.fromtimestamp(r['deadline'],datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC'); t.write_text('\\n'.join('OnCalendar='+deadline if line.startswith('OnCalendar=') else line for line in lines)+'\\n')`;
    await docker(["exec", name, "python3", "-c", script]);
    await docker(["exec", name, "systemctl", "daemon-reload"]);
    await docker([
      "exec",
      name,
      "systemctl",
      "restart",
      `openship-network-${managedId}-rollback.timer`,
    ]);
  }
  await docker(["stop", names[0]!]);
  await delay(10_000);
  await docker(["start", names[0]!]);
  await systemdReady(names[0]!);
  for (const name of names) {
    let stage = "";
    for (let attempt = 0; attempt < 40; attempt++) {
      stage = (
        await docker([
          "exec",
          name,
          "python3",
          "-c",
          `import json; print(json.load(open('${stateDir}/receipt.json'))['stage'])`,
        ])
      ).trim();
      if (stage === "rolled_back") break;
      await delay(250);
    }
    assert.equal(stage, "rolled_back");
  }
  config = {
    ...config,
    members: config.members.map((member, i) => ({ ...member, publicKey: originalKeys[i] })),
  };
  await verify();
  assert((await inspect()).every((host, i) => host.publicKey === originalKeys[i]));
  passed(
    "Host timers restore uncommitted keys without a controller, including a missed deadline during reboot",
  );
  observations = await inspect();
  tx = transactions();
  await prepare(tx);
  const fullConfig = config;
  config = { ...config, members: config.members.slice(0, 2) };
  await apply(tx);
  await verify();
  await Promise.all(executors.map((executor, i) => managedNetworkTools.commit(executor, tx[i]!)));
  assert.equal(
    (
      await docker([
        "exec",
        names[2]!,
        "sh",
        "-c",
        `test ! -e ${stateDir}/private.key && echo absent`,
      ])
    ).trim(),
    "absent",
  );
  passed("Removing a member cleans its interface, routes, firewall rules and live key");
  // Restore the approved operation to exercise removing the entire managed network.
  await Promise.all(executors.map((executor, i) => managedNetworkTools.rollback(executor, tx[i]!)));
  config = fullConfig;
  await verify();
  observations = await inspect();
  tx = transactions();
  await prepare(tx);
  await Promise.all(
    executors.map((executor, i) => managedNetworkTools.apply(executor, tx[i]!, null)),
  );
  await Promise.all(executors.map((executor, i) => managedNetworkTools.commit(executor, tx[i]!)));
  await Promise.all(executors.map((executor, i) => managedNetworkTools.finalize(executor, tx[i]!)));
  for (const name of names) {
    const links = JSON.parse(await docker(["exec", name, "ip", "-j", "link", "show"]));
    assert(!links.some((link: { ifname: string }) => link.ifname === interfaceName));
    const rules = await docker(["exec", name, "iptables-save"]);
    assert(!rules.includes(managedId.slice(0, 16)));
    if (name === names[2]) {
      assert(rules.includes("-A INPUT -p tcp -m tcp --dport 22 -j ACCEPT"));
      assert(rules.includes(":INPUT DROP"));
    }
    const nftRules = await docker(["exec", name, "nft", "-j", "list", "ruleset"]);
    assert(!nftRules.includes(managedId.slice(0, 16)));
    assert.equal(
      (
        await docker([
          "exec",
          name,
          "sh",
          "-c",
          `test ! -e ${stateDir}/private.key && test ! -e ${stateDir}/staged.key && test ! -e ${stateDir}/before.key && echo absent`,
        ])
      ).trim(),
      "absent",
    );
  }
  passed("Network deletion removes only owned resources and all stored key material");
  console.log(`${completed.length} managed-network lifecycle checks passed.`);
} finally {
  await Promise.allSettled(names.map((name) => docker(["rm", "-f", name])));
  await docker(["network", "rm", network]).catch(() => undefined);
  await docker(["image", "rm", image]).catch(() => undefined);
  await rm(build, { recursive: true, force: true });
}
