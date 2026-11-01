import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  NETWORK_LATENCY_SAMPLES,
  NETWORK_SPEED_DURATION_MS,
  NETWORK_SPEED_MAX_BYTES,
} from "@repo/core";
import {
  CHECK_PRIVATE_NETWORK,
  LISTEN_PRIVATE_NETWORK,
  MEASURE_PRIVATE_THROUGHPUT,
  STOP_PRIVATE_NETWORK,
  privateNetworkTools,
} from "./private-network";
import { MANAGED_NETWORK_HOST } from "./managed-network-host";
import type { CommandExecutor } from "../types";

const exec = promisify(execFile);
const pythonAvailable = (() => {
  try {
    execFileSync("python3", ["--version"]);
    return true;
  } catch {
    return false;
  }
})();
async function python(program: string, input: unknown) {
  const { stdout } = await exec("python3", ["-c", program, JSON.stringify(input)], {
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
  });
  return JSON.parse(stdout);
}
async function loopbackFixture(
  test: (source: Record<string, unknown>, target: Record<string, unknown>) => Promise<void>,
  speed = true,
) {
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const target = { serverId: "target", privateIp: "127.0.0.1", port, token: "a".repeat(48) };
  const source = { ...target, serverId: "source" };
  // The host programs are tested on loopback only. Production adapter validation
  // requires infrastructure-private addresses and distinct source/target hosts.
  await python(LISTEN_PRIVATE_NETWORK, {
    ...target,
    allowed: [target.privateIp],
    ttlSeconds: 20,
    throughputPeer: speed ? source.privateIp : undefined,
    speedMaxBytes: NETWORK_SPEED_MAX_BYTES,
    speedDurationMs: NETWORK_SPEED_DURATION_MS,
  });
  try {
    await test(source, target);
  } finally {
    await python(STOP_PRIVATE_NETWORK, target);
  }
}

describe.skipIf(!pythonAvailable)("real local network probe programs", () => {
  it("measures UDP round trips independently of a slow TCP check", async () => {
    await loopbackFixture(async (source, target) => {
      const delayedTcp = `import socket, time\nOriginalSocket = socket.socket\nclass SlowTcp(OriginalSocket):\n def connect(self, address):\n  if self.type == socket.SOCK_STREAM: time.sleep(0.25)\n  return super().connect(address)\nsocket.socket = SlowTcp\n`;
      const result = await python(delayedTcp + CHECK_PRIVATE_NETWORK, {
        ...source,
        peers: [target],
        mtu: 1400,
        latencySamples: NETWORK_LATENCY_SAMPLES,
      });
      expect(result.peers[0]).toMatchObject({
        tcp: true,
        udp: true,
        reachable: true,
        latencyKind: "rtt",
        packetLossPercent: 0,
      });
      expect(result.peers[0].latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.peers[0].latencyMs).toBeLessThan(200);
      expect(result.peers[0].jitterMs).toBeGreaterThanOrEqual(0);
    });
  });
  it("counts lost UDP probes and keeps missing latency distinct from a zero measurement", async () => {
    await loopbackFixture(async (source, target) => {
      const result = await python(CHECK_PRIVATE_NETWORK, {
        ...source,
        peers: [{ ...target, token: "b".repeat(48) }],
        mtu: 1400,
        latencySamples: NETWORK_LATENCY_SAMPLES,
      });
      expect(result.peers[0]).toMatchObject({
        tcp: false,
        udp: false,
        reachable: true,
        latencyMs: null,
        packetLossPercent: 100,
        jitterMs: null,
      });
      expect(result.peers[0].message).toContain("3/3 UDP echo probes were lost");
    });
  }, 10_000);
  it("returns receiver-confirmed bounded throughput and accepts only one speed request per listener", async () => {
    await loopbackFixture(async (source, target) => {
      const input = {
        ...source,
        peer: target,
        speedMaxBytes: NETWORK_SPEED_MAX_BYTES,
        speedDurationMs: NETWORK_SPEED_DURATION_MS,
      };
      const result = await python(MEASURE_PRIVATE_THROUGHPUT, input);
      expect(result.message).toBeNull();
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.bytes).toBeLessThanOrEqual(NETWORK_SPEED_MAX_BYTES);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.durationMs).toBeLessThanOrEqual(NETWORK_SPEED_DURATION_MS + 2000);
      expect(result.megabitsPerSecond).toBeCloseTo(
        (result.bytes * 8) / result.durationMs / 1000,
        3,
      );
      expect((await python(MEASURE_PRIVATE_THROUGHPUT, input)).megabitsPerSecond).toBeNull();
    });
  });
  it("does not enable bulk traffic for an ordinary connectivity listener", async () => {
    await loopbackFixture(async (source, target) => {
      const result = await python(MEASURE_PRIVATE_THROUGHPUT, {
        ...source,
        peer: target,
        speedMaxBytes: NETWORK_SPEED_MAX_BYTES,
        speedDurationMs: NETWORK_SPEED_DURATION_MS,
      });
      expect(result).toMatchObject({
        bytes: 0,
        megabitsPerSecond: null,
        message: expect.any(String),
      });
    }, false);
  });
});

const inspectionFailureHarness = String.raw`
import json, pathlib, shutil, subprocess, sys, tempfile, types
input = json.loads(sys.argv[1])
exists = pathlib.Path.exists; read_text = pathlib.Path.read_text
pathlib.Path.exists = lambda path: str(path) == '/sys/module/wireguard' or exists(path)
pathlib.Path.read_text = lambda path, *args, **kwargs: 'header\n' if str(path).startswith('/proc/net/udp') else read_text(path, *args, **kwargs)
shutil.which = lambda command: '/fixture/' + command
def command(args, **kwargs):
 if args[:len(input['command'])] == input['command']:
  if input.get('failure') == 'timeout': raise subprocess.TimeoutExpired(args, 30, stderr=input['stderr'].encode())
  if input.get('failure') == 'missing': raise FileNotFoundError(2, 'No such file or directory', args[0])
  return types.SimpleNamespace(returncode=input.get('exit', 2), stdout=input.get('stdout', ''), stderr=input.get('stderr', ''))
 if args == ['docker', 'network', 'ls', '-q']: output = 'fixture-network\n'
 elif args[:3] == ['docker', 'network', 'inspect']: output = '[{"IPAM":{"Config":[]}}]'
 elif args[0] == 'sh': output = ''
 else: output = '[]'
 return types.SimpleNamespace(returncode=0, stdout=output, stderr='')
subprocess.run = command
with tempfile.TemporaryDirectory() as directory:
 config = {'managedId': 'a' * 32, 'interfaceName': 'oswg' + 'a' * 10, 'stateDir': directory, 'listenPort': 51820, 'firewallInspect': 'private-shell-configuration', 'transportEndpoints': ['192.0.2.3']}
 if input.get('privateKey'):
  base = pathlib.Path(directory) / 'networks' / config['managedId']; base.mkdir(parents=True)
  (base / 'private.key').write_text(input['privateKey'])
 sys.argv = ['test', 'inspect', json.dumps(config)]
 exec(input['program'], {})
`;
describe.skipIf(!pythonAvailable)("managed host command diagnostics", () => {
  it.each([
    {
      command: ["ip", "-d", "-j", "addr", "show"],
      label: "ip -d -j addr show",
      stderr: "RTNETLINK answers: Operation not permitted",
    },
    {
      command: ["ip", "-j", "-4", "route", "show", "table", "all"],
      label: "ip -j -4 route show table all",
      stderr: "RTNETLINK answers: Invalid argument",
    },
    {
      command: ["docker", "network", "ls"],
      label: "docker network ls -q",
      stderr:
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
    },
    {
      command: ["docker", "network", "inspect"],
      label: "docker network inspect",
      stderr: "Error response from daemon: network fixture-network not found",
    },
    {
      command: ["sh", "-c"],
      label: "Inspect host firewall rules",
      stderr: "iptables-save: Permission denied (you must be root)",
    },
    {
      command: ["ip", "-j", "-4", "route", "get"],
      label: "ip -j -4 route get 192.0.2.3",
      stderr: "RTNETLINK answers: Network is unreachable",
    },
  ])(
    "retains the failed check, exit status, and stderr for $label",
    async ({ label, ...input }) => {
      const result = await python(inspectionFailureHarness, {
        program: MANAGED_NETWORK_HOST,
        ...input,
      });
      expect(result).toEqual({
        code: "MANAGED_NETWORK_COMMAND_FAILED",
        error: `${label} failed (exit 2): ${input.stderr}`,
      });
      expect(result.error).not.toContain("private-shell-configuration");
    },
  );
  it.each([
    {
      failure: "timeout",
      code: "MANAGED_NETWORK_COMMAND_TIMEOUT",
      detail: "timed out after 30 seconds: kernel inspection stalled",
    },
    {
      failure: "missing",
      code: "MANAGED_NETWORK_COMMAND_UNAVAILABLE",
      detail: "could not start: No such file or directory",
    },
  ])(
    "identifies a $failure command without exposing the Python wrapper",
    async ({ code, detail, failure }) => {
      const result = await python(inspectionFailureHarness, {
        program: MANAGED_NETWORK_HOST,
        command: ["ip"],
        failure,
        stderr: "kernel inspection stalled",
      });
      expect(result.code).toBe(code);
      expect(result.error).toBe(`ip -d -j addr show ${detail}`);
    },
  );
  it("redacts key material and credentials while retaining the diagnostic", async () => {
    const key = "K".repeat(43) + "=";
    const result = await python(inspectionFailureHarness, {
      program: MANAGED_NETWORK_HOST,
      command: ["ip"],
      stderr: `\u001b[31mRTNETLINK answers: Network is unreachable\u001b[0m\u0000\nKey: '${key}'\nPrivateKey = short-private-secret\nAuthorization: Bearer credential-secret\nhttps://user:password-secret@example.test/network`,
    });
    expect(result.error).toContain("RTNETLINK answers: Network is unreachable");
    expect(result.error).toContain("[redacted]@example.test/network");
    expect(result.error).not.toMatch(
      /credential-secret|password-secret|short-private-secret|\u0000|\u001b/,
    );
    expect(result.error).not.toContain(key);
  });
  it("reports invalid command output without copying its contents", async () => {
    const result = await python(inspectionFailureHarness, {
      program: MANAGED_NETWORK_HOST,
      command: ["ip"],
      exit: 0,
      stdout: "private-command-output",
    });
    expect(result.code).toBe("MANAGED_NETWORK_REPORT_INVALID");
    expect(result.error).toContain("ip -d -j addr show returned invalid JSON");
    expect(result.error).not.toContain("private-command-output");
  });
  it("redacts stdin even when a malformed private key is echoed by its command", async () => {
    const result = await python(inspectionFailureHarness, {
      program: MANAGED_NETWORK_HOST,
      command: ["wg", "pubkey"],
      privateKey: "short-invalid-fixture-key",
      stderr: "Key is not the correct length or format: 'short-invalid-fixture-key'",
    });
    expect(result.error).toContain("wg pubkey failed (exit 2)");
    expect(result.error).toContain("Key is not the correct length or format");
    expect(result.error).not.toContain("short-invalid-fixture-key");
  });
});

const handshakeHarness = String.raw`
import json, pathlib, subprocess, sys, tempfile, types
input = json.loads(sys.argv[1])
with tempfile.TemporaryDirectory() as directory:
 managed_id = 'a' * 32; iface = 'oswg' + managed_id[:10]
 base = pathlib.Path(directory) / 'networks' / managed_id; base.mkdir(parents=True)
 config = {'interfaceName': iface, 'mtu': 1400, 'privateIp': '10.244.0.1', 'listenPort': 51820, 'transportOnly': True, 'firewall': {'up': [], 'down': [], 'inspect': 'true'}, 'peers': [
  {'serverId': 'b', 'publicKey': 'peer-b', 'privateIp': '10.244.0.2', 'endpoint': '192.0.2.2', 'listenPort': 51820},
  {'serverId': 'c', 'publicKey': 'peer-c', 'privateIp': '10.244.0.3', 'endpoint': '192.0.2.3', 'listenPort': 51822},
 ]}
 (base / 'network.json').write_text(json.dumps(config)); (base / 'private.key').write_text('private-key-fixture')
 before = {p.name: p.read_text() for p in base.iterdir()}
 def command(args, **kwargs):
  if args[-1] == 'latest-handshakes': output = 'peer-b 1700000000\npeer-c ' + ('0' if input.get('missing') else '1700000000') + '\n'
  elif args[-1] == 'peers': output = 'peer-b\npeer-c\n'
  elif args[-1] == 'public-key': output = 'different-key' if input.get('drift') else 'local-public'
  elif args[-1] == 'pubkey': output = 'local-public'
  elif args[-1] == 'listen-port': output = '51820'
  elif args[-1] == 'allowed-ips': output = 'peer-b\t10.244.0.2/32\npeer-c\t10.244.0.3/32\n'
  elif args == ['ip', '-d', '-j', 'addr', 'show']:
   output = json.dumps([{'ifname': iface, 'flags': ['UP'], 'mtu': 1400, 'linkinfo': {'info_kind': 'wireguard'}, 'addr_info': []}])
  else: raise AssertionError('Unexpected command')
  return types.SimpleNamespace(returncode=0, stdout=output, stderr='')
 subprocess.run = command
 sys.argv = ['test', 'ready', json.dumps({'managedId': managed_id, 'interfaceName': iface, 'stateDir': directory, 'waitSeconds': 0})]
 try: exec(input['program'], {})
 except SystemExit as error:
  if error.code: raise
 assert before == {p.name: p.read_text() for p in base.iterdir()}
`;
describe.skipIf(!pythonAvailable)("WireGuard host handshake diagnostics", () => {
  it("identifies an isolated peer while retaining the successful peer and exact destination port", async () => {
    const result = await python(handshakeHarness, { program: MANAGED_NETWORK_HOST, missing: true });
    expect(result).toMatchObject({
      ready: false,
      interfaceReady: true,
      peers: [
        { serverId: "b", ok: true, lastHandshakeAt: expect.any(String) },
        { serverId: "c", endpoint: "192.0.2.3", port: 51822, ok: false, lastHandshakeAt: null },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("private-key-fixture");
    expect(JSON.stringify(result)).not.toContain("peer-b");
  });
  it("distinguishes configuration drift from missing peer handshakes", async () => {
    expect(
      await python(handshakeHarness, { program: MANAGED_NETWORK_HOST, drift: true }),
    ).toMatchObject({
      ready: false,
      interfaceReady: false,
      peers: [expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })],
    });
    expect(await python(handshakeHarness, { program: MANAGED_NETWORK_HOST })).toMatchObject({
      ready: true,
      interfaceReady: true,
    });
  });
});

describe("speed report boundary", () => {
  const source = { serverId: "source", privateIp: "10.0.0.1", port: 51821, token: "a".repeat(48) };
  const target = { ...source, serverId: "target", privateIp: "10.0.0.2" };
  it.each([
    { bytes: NETWORK_SPEED_MAX_BYTES + 1 },
    { durationMs: 10000 },
    { sourceServerId: "another-host" },
    { megabitsPerSecond: -1 },
  ])("rejects an invalid receiver report: %j", async (override) => {
    const executor = {
      exec: async () =>
        JSON.stringify({
          sourceServerId: source.serverId,
          targetServerId: target.serverId,
          bytes: 1000,
          durationMs: 10,
          megabitsPerSecond: 0.8,
          message: null,
          ...override,
        }),
    } as unknown as CommandExecutor;
    await expect(privateNetworkTools.throughput(executor, source, target)).rejects.toMatchObject({
      code: "NETWORK_REPORT_INVALID",
    });
  });
});
