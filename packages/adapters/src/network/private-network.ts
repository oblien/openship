import type { CommandExecutor } from "../types";
import { sq } from "../runtime/git-clone";
import {
  isInfrastructurePrivateIp,
  NETWORK_PROBE_TTL_SECONDS,
  NETWORK_LATENCY_SAMPLES,
  NETWORK_SPEED_MAX_BYTES,
  NETWORK_SPEED_DURATION_MS,
  type NetworkInterfaceObservation,
  type ClusterPeerCheck,
  type ClusterThroughputCheck,
} from "@repo/core";

/** Temporary, authenticated probes. They never change routes, interfaces, or firewall rules. */
export interface PrivateNetworkProbe {
  serverId: string;
  privateIp: string;
  port: number;
  token: string;
}
export class PrivateNetworkError extends Error {
  constructor(
    message: string,
    readonly code = "NETWORK_CHECK_FAILED",
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const INSPECT_PRIVATE_NETWORK = String.raw`
import json, subprocess, sys
if sys.platform != 'linux':
    print(json.dumps({'error': 'Linux hosts are required.', 'code': 'NETWORK_HOST_UNSUPPORTED'})); sys.exit(0)
try:
    links = json.loads(subprocess.check_output(['ip', '-d', '-j', 'addr', 'show'], timeout=10))
    print(json.dumps({'interfaces': [{
        'name': x['ifname'], 'mtu': x['mtu'], 'up': 'UP' in x.get('flags', []),
        'kind': x.get('linkinfo', {}).get('info_kind'),
        'addresses': [{'address': a['local'], 'prefixLength': a['prefixlen']} for a in x.get('addr_info', []) if a.get('family') == 'inet']
    } for x in links]}))
except Exception:
    print(json.dumps({'error': 'Install iproute2 and Python 3, then inspect the network again.', 'code': 'NETWORK_TOOLS_UNAVAILABLE'}))
`;

// Bind before forking so occupied ports fail without spawning a worker. A child
// expires independently of the controller. It only echoes a per-run token from
// explicitly selected peers; there is no public bind and no UDP amplification.
export const LISTEN_PRIVATE_NETWORK = String.raw`
import json, os, selectors, socket, sys, time
c = json.loads(sys.argv[1])
tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
try:
    tcp.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    tcp.bind((c['privateIp'], c['port'])); tcp.listen(32)
    udp.bind((c['privateIp'], c['port']))
except OSError:
    tcp.close(); udp.close()
    print(json.dumps({'error': 'The verification port is unavailable on this private address. Choose another port or fix the interface.', 'code': 'NETWORK_PROBE_PORT_UNAVAILABLE'})); sys.exit(0)
pid = os.fork()
if pid:
    tcp.close(); udp.close(); print(json.dumps({'started': True})); sys.exit(0)
os.setsid()
null = os.open(os.devnull, os.O_RDWR)
for fd in (0, 1, 2): os.dup2(null, fd)
if null > 2: os.close(null)
selector = selectors.DefaultSelector()
selector.register(tcp, selectors.EVENT_READ); selector.register(udp, selectors.EVENT_READ)
deadline = time.monotonic() + c['ttlSeconds']
prefix = (c['token'] + '|').encode()
allowed = set(c['allowed'])
speed_available = bool(c.get('throughputPeer'))
try:
    while time.monotonic() < deadline:
        for key, _ in selector.select(0.25):
            if key.fileobj is udp:
                data, address = udp.recvfrom(9000)
                if address[0] in allowed and data.startswith(prefix): udp.sendto(data, address)
            else:
                conn, address = tcp.accept()
                try:
                    conn.settimeout(0.3)
                    data = b''
                    while len(data) < 128 and not data.endswith(b'\n'):
                        part = conn.recv(128 - len(data))
                        if not part: break
                        data += part
                    if address[0] in allowed and data.startswith(prefix) and data.endswith(b'\n'):
                        if data == prefix + b'throughput\n' and speed_available and address[0] == c.get('throughputPeer'):
                            speed_available = False
                            conn.sendall(prefix + b'ready\n')
                            started = time.monotonic(); received = 0
                            stop_at = min(deadline, started + c['speedDurationMs'] / 1000 + 1)
                            while received < c['speedMaxBytes'] and time.monotonic() < stop_at:
                                conn.settimeout(max(0.001, stop_at - time.monotonic()))
                                try: chunk = conn.recv(min(65536, c['speedMaxBytes'] - received))
                                except socket.timeout: break
                                if not chunk: break
                                received += len(chunk)
                            elapsed = max(0.001, time.monotonic() - started)
                            conn.settimeout(1)
                            conn.sendall((json.dumps({'bytes': received, 'durationMs': round(elapsed * 1000, 3)}) + '\n').encode())
                        elif data == prefix + b'tcp\n' or data == prefix + b'stop\n':
                            conn.sendall(data)
                            if data == prefix + b'stop\n' and address[0] == c['privateIp']: deadline = 0
                except OSError: pass
                finally: conn.close()
finally:
    selector.close(); tcp.close(); udp.close()
    os._exit(0)
`;

export const CHECK_PRIVATE_NETWORK = String.raw`
import concurrent.futures, json, socket, sys, time
c = json.loads(sys.argv[1])
def check(peer):
    r = {'sourceServerId': c['serverId'], 'targetServerId': peer['serverId'], 'tcp': False, 'udp': False, 'mtu': False, 'reachable': False, 'latencyMs': None, 'latencyKind': 'rtt', 'packetLossPercent': None, 'jitterMs': None, 'message': None}
    prefix = (peer['token'] + '|').encode()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(2); s.bind((c['privateIp'], 0)); s.connect((peer['privateIp'], peer['port']))
            r['reachable'] = True
            s.sendall(prefix + b'tcp\n')
            expected = prefix + b'tcp\n'
            received = b''
            while len(received) < len(expected):
                part = s.recv(len(expected) - len(received))
                if not part: break
                received += part
            r['tcp'] = received == expected
    except OSError: pass
    samples = []
    for sample in range(c['latencySamples']):
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
                s.settimeout(1); s.bind((c['privateIp'], 0)); s.connect((peer['privateIp'], peer['port']))
                packet = prefix + ('udp:' + str(sample)).encode()
                started = time.monotonic()
                s.send(packet)
                received = s.recv(9000); r['reachable'] = True
                if received == packet: samples.append((time.monotonic() - started) * 1000)
        except OSError: pass
    r['udp'] = len(samples) == c['latencySamples']
    r['packetLossPercent'] = round((c['latencySamples'] - len(samples)) * 100 / c['latencySamples'], 1)
    if samples: r['latencyMs'] = round(sum(samples) / len(samples), 3)
    if len(samples) > 1: r['jitterMs'] = round(sum(abs(b-a) for a, b in zip(samples, samples[1:])) / (len(samples)-1), 3)
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(2); s.bind((c['privateIp'], 0)); s.connect((peer['privateIp'], peer['port']))
            if sys.platform == 'linux':
                # Linux IP_MTU_DISCOVER=10 / IP_PMTUDISC_DO=2: prohibit fragmentation.
                s.setsockopt(socket.IPPROTO_IP, 10, 2)
                packet = prefix + b'm' * (c['mtu'] - 28 - len(prefix))
                s.send(packet); received = s.recv(9000); r['reachable'] = True; r['mtu'] = received == packet
    except OSError: pass
    problems = []
    if not r['tcp']: problems.append('TCP connection failed; check private routes and the verification port firewall rules.')
    if not r['udp']: problems.append(str(c['latencySamples'] - len(samples)) + '/' + str(c['latencySamples']) + ' UDP echo probes were lost; check UDP rules and packet loss.')
    if not r['mtu']: problems.append('The unfragmented MTU probe failed; check the tunnel MTU and UDP path.')
    if problems: r['message'] = ' '.join(problems)
    return r
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    print(json.dumps({'peers': list(pool.map(check, c['peers']))}))
`;

/** Receiver-confirmed application throughput over the private route, bounded on both hosts. */
export const MEASURE_PRIVATE_THROUGHPUT = String.raw`
import json, socket, sys, time
c = json.loads(sys.argv[1]); peer = c['peer']
r = {'sourceServerId': c['serverId'], 'targetServerId': peer['serverId'], 'megabitsPerSecond': None, 'bytes': 0, 'durationMs': 0, 'message': None}
prefix = (peer['token'] + '|').encode()
try:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(2); s.bind((c['privateIp'], 0)); s.connect((peer['privateIp'], peer['port']))
        s.sendall(prefix + b'throughput\n')
        expected = prefix + b'ready\n'; response = b''
        while len(response) < len(expected):
            part = s.recv(len(expected) - len(response))
            if not part: break
            response += part
        if response != expected: raise ValueError('Speed test listener did not acknowledge the request.')
        deadline = time.monotonic() + c['speedDurationMs'] / 1000
        chunk = b'\x5a' * 65536; sent = 0
        while sent < c['speedMaxBytes'] and time.monotonic() < deadline:
            s.settimeout(max(0.001, deadline - time.monotonic()))
            try: amount = s.send(chunk[:min(len(chunk), c['speedMaxBytes'] - sent)])
            except socket.timeout: break
            if not amount: break
            sent += amount
        s.shutdown(socket.SHUT_WR); s.settimeout(2)
        response = b''
        while len(response) < 1024 and not response.endswith(b'\n'):
            part = s.recv(1024 - len(response))
            if not part: break
            response += part
        result = json.loads(response)
        received = result['bytes']; elapsed = result['durationMs']
        if not isinstance(received, int) or not 0 < received <= sent or not isinstance(elapsed, (float, int)) or not 0 < elapsed <= c['speedDurationMs'] + 2000: raise ValueError('Invalid speed sample receipt.')
        r.update({'bytes': received, 'durationMs': elapsed, 'megabitsPerSecond': round(received * 8 / elapsed / 1000, 3)})
except (OSError, ValueError, KeyError, TypeError):
    r['message'] = 'The private speed sample did not complete. Check the connection results and retry the selected link.'
print(json.dumps(r))
`;

export const STOP_PRIVATE_NETWORK = String.raw`
import json, socket, sys
c = json.loads(sys.argv[1])
try:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1); s.bind((c['privateIp'], 0)); s.connect((c['privateIp'], c['port']))
        s.sendall((c['token'] + '|stop\n').encode()); s.recv(128)
except OSError: pass
print('{}')
`;

function validateProbe(probe: PrivateNetworkProbe) {
  if (
    !isInfrastructurePrivateIp(probe.privateIp) ||
    !Number.isInteger(probe.port) ||
    probe.port < 1024 ||
    probe.port > 65535 ||
    !/^[a-f0-9]{48}$/.test(probe.token)
  )
    throw new PrivateNetworkError("Invalid private network probe configuration.");
}

async function runJson<T>(
  executor: CommandExecutor,
  script: string,
  input: unknown = {},
  timeout = 15_000,
): Promise<T> {
  let output: string;
  try {
    output = await executor.exec(`python3 -c ${sq(script)} ${sq(JSON.stringify(input))}`, {
      timeout,
    });
  } catch {
    throw new PrivateNetworkError(
      "Couldn't run the network check. Verify SSH access and install Python 3 and iproute2.",
      "NETWORK_EXECUTION_FAILED",
    );
  }
  let data: T & { error?: string; code?: string };
  try {
    data = JSON.parse(output);
  } catch {
    throw new PrivateNetworkError(
      "The host returned an invalid network report.",
      "NETWORK_REPORT_INVALID",
    );
  }
  if (!data || typeof data !== "object")
    throw new PrivateNetworkError(
      "The host returned an invalid network report.",
      "NETWORK_REPORT_INVALID",
    );
  if (data.error) throw new PrivateNetworkError(String(data.error).slice(0, 512), data.code);
  return data;
}

/** Reusable host inspection and probes for native and managed networks. */
export const privateNetworkTools = {
  async inspect(executor: CommandExecutor): Promise<NetworkInterfaceObservation[]> {
    const result = await runJson<{ interfaces: NetworkInterfaceObservation[] }>(
      executor,
      INSPECT_PRIVATE_NETWORK,
    );
    if (!Array.isArray(result.interfaces))
      throw new PrivateNetworkError("The host returned an invalid interface report.");
    return result.interfaces;
  },
  async listen(
    executor: CommandExecutor,
    probe: PrivateNetworkProbe,
    allowed: string[],
    throughputPeer?: string,
  ): Promise<void> {
    validateProbe(probe);
    if (!allowed.every(isInfrastructurePrivateIp))
      throw new PrivateNetworkError("Invalid peer address.");
    if (throughputPeer && (!allowed.includes(throughputPeer) || throughputPeer === probe.privateIp))
      throw new PrivateNetworkError("Invalid speed test peer.");
    await runJson(executor, LISTEN_PRIVATE_NETWORK, {
      ...probe,
      allowed,
      ttlSeconds: NETWORK_PROBE_TTL_SECONDS,
      throughputPeer,
      speedMaxBytes: NETWORK_SPEED_MAX_BYTES,
      speedDurationMs: NETWORK_SPEED_DURATION_MS,
    });
  },
  async check(
    executor: CommandExecutor,
    source: PrivateNetworkProbe,
    peers: PrivateNetworkProbe[],
    mtu: number,
  ): Promise<ClusterPeerCheck[]> {
    [source, ...peers].forEach(validateProbe);
    if (!Number.isInteger(mtu) || mtu < 1280 || mtu > 9000 || peers.length > 15)
      throw new PrivateNetworkError("Invalid network verification size.");
    const result = await runJson<{ peers: ClusterPeerCheck[] }>(
      executor,
      CHECK_PRIVATE_NETWORK,
      { ...source, peers, mtu, latencySamples: NETWORK_LATENCY_SAMPLES },
      40_000,
    );
    if (
      !Array.isArray(result.peers) ||
      result.peers.length !== peers.length ||
      !result.peers.every(
        (p) =>
          p &&
          p.sourceServerId === source.serverId &&
          peers.some((peer) => peer.serverId === p.targetServerId) &&
          typeof p.tcp === "boolean" &&
          typeof p.udp === "boolean" &&
          typeof p.mtu === "boolean" &&
          (p.reachable === undefined || typeof p.reachable === "boolean") &&
          !(p.reachable === false && (p.tcp || p.udp || p.mtu)) &&
          (p.latencyMs === null ||
            (typeof p.latencyMs === "number" &&
              Number.isFinite(p.latencyMs) &&
              p.latencyMs >= 0)) &&
          p.latencyKind === "rtt" &&
          typeof p.packetLossPercent === "number" &&
          Number.isFinite(p.packetLossPercent) &&
          p.packetLossPercent >= 0 &&
          p.packetLossPercent <= 100 &&
          (p.jitterMs === null ||
            (typeof p.jitterMs === "number" && Number.isFinite(p.jitterMs) && p.jitterMs >= 0)) &&
          (p.message === null || (typeof p.message === "string" && p.message.length <= 512)),
      ) ||
      new Set(result.peers.map((p) => p.targetServerId)).size !== peers.length
    )
      throw new PrivateNetworkError("The host returned an incomplete or invalid peer report.");
    return result.peers.map(
      ({
        sourceServerId,
        targetServerId,
        tcp,
        udp,
        mtu,
        reachable,
        latencyMs,
        latencyKind,
        packetLossPercent,
        jitterMs,
        message,
      }) => ({
        sourceServerId,
        targetServerId,
        tcp,
        udp,
        mtu,
        ...(reachable !== undefined ? { reachable } : {}),
        latencyMs,
        latencyKind,
        packetLossPercent,
        jitterMs,
        message,
      }),
    );
  },
  async throughput(
    executor: CommandExecutor,
    source: PrivateNetworkProbe,
    peer: PrivateNetworkProbe,
  ): Promise<ClusterThroughputCheck> {
    [source, peer].forEach(validateProbe);
    if (source.serverId === peer.serverId || source.privateIp === peer.privateIp)
      throw new PrivateNetworkError("Choose two distinct servers for the speed test.");
    const result = await runJson<ClusterThroughputCheck>(
      executor,
      MEASURE_PRIVATE_THROUGHPUT,
      {
        ...source,
        peer,
        speedMaxBytes: NETWORK_SPEED_MAX_BYTES,
        speedDurationMs: NETWORK_SPEED_DURATION_MS,
      },
      12_000,
    );
    if (
      result.sourceServerId !== source.serverId ||
      result.targetServerId !== peer.serverId ||
      !Number.isInteger(result.bytes) ||
      result.bytes < 0 ||
      result.bytes > NETWORK_SPEED_MAX_BYTES ||
      !Number.isFinite(result.durationMs) ||
      result.durationMs < 0 ||
      result.durationMs > NETWORK_SPEED_DURATION_MS + 2000 ||
      (result.megabitsPerSecond !== null &&
        (!Number.isFinite(result.megabitsPerSecond) ||
          result.megabitsPerSecond <= 0 ||
          result.bytes === 0 ||
          result.durationMs === 0)) ||
      (result.message !== null &&
        (typeof result.message !== "string" || result.message.length > 512)) ||
      (result.megabitsPerSecond === null) !== (result.message !== null)
    )
      throw new PrivateNetworkError(
        "The host returned an invalid speed sample.",
        "NETWORK_REPORT_INVALID",
      );
    return {
      sourceServerId: source.serverId,
      targetServerId: peer.serverId,
      bytes: result.bytes,
      durationMs: result.durationMs,
      message: result.message,
      megabitsPerSecond:
        result.megabitsPerSecond === null
          ? null
          : Math.round((result.bytes * 8) / result.durationMs) / 1000,
    };
  },
  async stop(executor: CommandExecutor, probe: PrivateNetworkProbe): Promise<void> {
    validateProbe(probe);
    await runJson(executor, STOP_PRIVATE_NETWORK, probe, 3000);
  },
};
