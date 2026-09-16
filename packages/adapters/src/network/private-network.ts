import type { CommandExecutor } from "../types";
import { sq } from "../runtime/git-clone";
import {
  isInfrastructurePrivateIp,
  NETWORK_PROBE_TTL_SECONDS,
  type NetworkInterfaceObservation,
  type ClusterPeerCheck,
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
  ) {
    super(message);
  }
}

export const INSPECT_PRIVATE_NETWORK = String.raw`
import json, subprocess, sys
if sys.platform != 'linux':
    print(json.dumps({'error': 'Linux hosts are required.', 'code': 'NETWORK_HOST_UNSUPPORTED'})); sys.exit(0)
try:
    links = json.loads(subprocess.check_output(['ip', '-d', '-j', '-4', 'addr', 'show'], timeout=10))
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
    r = {'sourceServerId': c['serverId'], 'targetServerId': peer['serverId'], 'tcp': False, 'udp': False, 'mtu': False, 'latencyMs': None, 'message': None}
    prefix = (peer['token'] + '|').encode()
    started = time.monotonic()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(2); s.bind((c['privateIp'], 0)); s.connect((peer['privateIp'], peer['port']))
            s.sendall(prefix + b'tcp\n')
            expected = prefix + b'tcp\n'
            received = b''
            while len(received) < len(expected):
                part = s.recv(len(expected) - len(received))
                if not part: break
                received += part
            r['tcp'] = received == expected
    except OSError: pass
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.settimeout(2); s.bind((c['privateIp'], 0)); s.connect((peer['privateIp'], peer['port']))
            s.send(prefix + b'udp'); r['udp'] = s.recv(9000) == prefix + b'udp'
            if sys.platform == 'linux':
                # Linux IP_MTU_DISCOVER=10 / IP_PMTUDISC_DO=2: prohibit fragmentation.
                s.setsockopt(socket.IPPROTO_IP, 10, 2)
                packet = prefix + b'm' * (c['mtu'] - 28 - len(prefix))
                s.send(packet); r['mtu'] = s.recv(9000) == packet
    except OSError: pass
    if r['tcp'] and r['udp'] and r['mtu']: r['latencyMs'] = round((time.monotonic() - started) * 1000, 1)
    else: r['message'] = 'Check private routes, TCP/UDP firewall rules for the verification port, and the path MTU.'
    return r
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    print(json.dumps({'peers': list(pool.map(check, c['peers']))}))
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

/** Reusable host inspection and probes for native networks and future overlay drivers. */
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
  ): Promise<void> {
    validateProbe(probe);
    if (!allowed.every(isInfrastructurePrivateIp))
      throw new PrivateNetworkError("Invalid peer address.");
    await runJson(executor, LISTEN_PRIVATE_NETWORK, {
      ...probe,
      allowed,
      ttlSeconds: NETWORK_PROBE_TTL_SECONDS,
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
      { ...source, peers, mtu },
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
          (p.latencyMs === null ||
            (typeof p.latencyMs === "number" &&
              Number.isFinite(p.latencyMs) &&
              p.latencyMs >= 0)) &&
          (p.message === null || (typeof p.message === "string" && p.message.length <= 512)),
      ) ||
      new Set(result.peers.map((p) => p.targetServerId)).size !== peers.length
    )
      throw new PrivateNetworkError("The host returned an incomplete or invalid peer report.");
    return result.peers;
  },
  async stop(executor: CommandExecutor, probe: PrivateNetworkProbe): Promise<void> {
    validateProbe(probe);
    await runJson(executor, STOP_PRIVATE_NETWORK, probe, 3000);
  },
};
