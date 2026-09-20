/**
 * Real Linux probe checks in disposable containers. Requires a Docker context.
 * bun packages/adapters/scripts/verify-private-network.ts <docker-context>
 * Nothing is published on the host; all resources belong to this invocation.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { privateNetworkTools, type PrivateNetworkProbe } from "../src/network/private-network";
import type { CommandExecutor } from "../src/types";
import { MAX_CLUSTER_MEMBERS } from "@repo/core";

const context = process.argv[2];
if (!context) throw new Error("Supply the Docker context to use for the isolated network test.");
const exec = promisify(execFile);
const docker = async (args: string[], timeout = 30_000) =>
  (await exec("docker", ["--context", context, ...args], { timeout, maxBuffer: 4 * 1024 * 1024 }))
    .stdout;
const suffix = randomBytes(5).toString("hex");
const network = `openship-network-test-${suffix}`;
const image = `openship-network-test:${suffix}`;
const names = [`openship-net-a-${suffix}`, `openship-net-b-${suffix}`];
const build = await mkdtemp(join(tmpdir(), "openship-network-image-"));
const results: string[] = [];
try {
  await writeFile(
    join(build, "Dockerfile"),
    'FROM alpine:3.21\nRUN apk add --no-cache python3 iproute2 iptables\nCMD ["sleep","600"]\n',
  );
  console.log("Building isolated Linux network fixtures…");
  await docker(["build", "-q", "-t", image, build], 180_000);
  await docker(["network", "create", "--internal", "--subnet", "10.253.246.0/27", network]);
  const probes: PrivateNetworkProbe[] = [];
  const executors: CommandExecutor[] = [];
  for (const [index, name] of names.entries()) {
    const privateIp = `10.253.246.${index + 2}`;
    await docker([
      "run",
      "-d",
      "--name",
      name,
      "--network",
      network,
      "--ip",
      privateIp,
      "--cap-add",
      "NET_ADMIN",
      image,
    ]);
    probes.push({ serverId: name, privateIp, port: 51821, token: randomBytes(24).toString("hex") });
    executors.push({
      exec: (command: string, opts?: { timeout?: number }) =>
        docker(["exec", name, "sh", "-c", command], opts?.timeout),
    } as CommandExecutor);
  }
  for (let i = 0; i < 2; i++) {
    const interfaces = await privateNetworkTools.inspect(executors[i]!);
    assert(
      interfaces.some(
        (nic) => nic.up && nic.addresses.some((a) => a.address === probes[i]!.privateIp),
      ),
    );
    await privateNetworkTools.listen(
      executors[i]!,
      probes[i]!,
      probes.map((p) => p.privateIp),
    );
  }
  results.push("Linux interface discovery and private listeners");
  for (let i = 0; i < 2; i++) {
    const [result] = await privateNetworkTools.check(
      executors[i]!,
      probes[i]!,
      [probes[1 - i]!],
      1400,
    );
    assert(result?.tcp && result.udp && result.mtu, JSON.stringify(result));
  }
  results.push("Bidirectional TCP, UDP, and unfragmented MTU checks");
  await assert.rejects(
    privateNetworkTools.listen(
      executors[0]!,
      { ...probes[0]!, token: randomBytes(24).toString("hex") },
      probes.map((p) => p.privateIp),
    ),
    /verification port/,
  );
  results.push("Occupied port does not replace an existing listener");
  const [wrongToken] = await privateNetworkTools.check(
    executors[0]!,
    probes[0]!,
    [{ ...probes[1]!, token: randomBytes(24).toString("hex") }],
    1400,
  );
  assert(wrongToken && !wrongToken.tcp && !wrongToken.udp && !wrongToken.mtu);
  results.push("Unknown authentication token is rejected");
  await docker(["exec", names[0]!, "ip", "link", "set", "dev", "eth0", "mtu", "1280"]);
  const [smallMtu] = await privateNetworkTools.check(executors[0]!, probes[0]!, [probes[1]!], 1400);
  assert(smallMtu?.tcp && smallMtu.udp && !smallMtu.mtu, JSON.stringify(smallMtu));
  await docker(["exec", names[0]!, "ip", "link", "set", "dev", "eth0", "mtu", "1500"]);
  results.push("MTU failure is distinct from TCP/UDP reachability");
  await docker([
    "exec",
    names[1]!,
    "iptables",
    "-I",
    "INPUT",
    "-p",
    "udp",
    "--dport",
    "51821",
    "-j",
    "DROP",
  ]);
  const [blockedUdp] = await privateNetworkTools.check(
    executors[0]!,
    probes[0]!,
    [probes[1]!],
    1400,
  );
  assert(blockedUdp?.tcp && !blockedUdp.udp && !blockedUdp.mtu, JSON.stringify(blockedUdp));
  results.push("UDP firewall failure cannot report a healthy network");
  for (let i = 0; i < 2; i++) await privateNetworkTools.stop(executors[i]!, probes[i]!);
  const [stopped] = await privateNetworkTools.check(executors[0]!, probes[0]!, [probes[1]!], 1400);
  assert(stopped && !stopped.tcp && !stopped.udp);
  results.push("Authenticated cleanup closes the listeners");
  await assert.rejects(
    privateNetworkTools.listen(executors[0]!, { ...probes[0]!, privateIp: "0.0.0.0" }, []),
    /Invalid/,
  );
  results.push("Public wildcard binding is rejected before execution");

  // Exercise the actual limit with the controller's four-host fan-out, including
  // all fifteen peers per source. No external connectivity or host ports.
  await docker([
    "exec",
    names[1]!,
    "iptables",
    "-D",
    "INPUT",
    "-p",
    "udp",
    "--dport",
    "51821",
    "-j",
    "DROP",
  ]);
  for (let index = 2; index < MAX_CLUSTER_MEMBERS; index++) {
    const name = `openship-net-${index}-${suffix}`;
    names.push(name);
    const privateIp = `10.253.246.${index + 2}`;
    await docker(["run", "-d", "--name", name, "--network", network, "--ip", privateIp, image]);
    probes.push({ serverId: name, privateIp, port: 51821, token: randomBytes(24).toString("hex") });
    executors.push({
      exec: (command: string, opts?: { timeout?: number }) =>
        docker(["exec", name, "sh", "-c", command], opts?.timeout),
    } as CommandExecutor);
  }
  for (let start = 0; start < probes.length; start += 4) {
    await Promise.all(
      probes.slice(start, start + 4).map((probe, offset) =>
        privateNetworkTools.listen(
          executors[start + offset]!,
          probe,
          probes.map((p) => p.privateIp),
        ),
      ),
    );
  }
  let connections = 0;
  for (let start = 0; start < probes.length; start += 4) {
    await Promise.all(
      probes.slice(start, start + 4).map(async (probe, offset) => {
        const checks = await privateNetworkTools.check(
          executors[start + offset]!,
          probe,
          probes.filter((peer) => peer.serverId !== probe.serverId),
          1400,
        );
        assert.equal(checks.length, MAX_CLUSTER_MEMBERS - 1);
        assert(
          checks.every((check) => check.tcp && check.udp && check.mtu),
          JSON.stringify(checks.filter((check) => !check.tcp || !check.udp || !check.mtu)),
        );
        connections += checks.length;
      }),
    );
  }
  assert.equal(connections, MAX_CLUSTER_MEMBERS * (MAX_CLUSTER_MEMBERS - 1));
  for (let i = 0; i < probes.length; i++) await privateNetworkTools.stop(executors[i]!, probes[i]!);
  results.push(
    `${MAX_CLUSTER_MEMBERS} Linux members: all ${connections} directed TCP/UDP/MTU connections`,
  );
  console.log(JSON.stringify({ ok: true, checks: results }, null, 2));
} finally {
  for (const name of names) await docker(["rm", "-f", name]).catch(() => undefined);
  await docker(["network", "rm", network]).catch(() => undefined);
  await docker(["image", "rm", image]).catch(() => undefined);
  await rm(build, { recursive: true, force: true });
}
