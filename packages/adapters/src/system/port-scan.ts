/**
 * Host port exposure scan — "what is listening on this machine, and which of it
 * is reachable from off-box?"
 *
 * This is the security-tab sibling of `port-listen.ts`. Where `port-listen`
 * answers "is ONE port listening?" and deliberately throws the bind address
 * away (it only needs the port number), a security scan MUST keep the bind
 * address — the whole question is whether a listener is bound to `0.0.0.0`/`::`
 * (exposed to the network) or to `127.0.0.1`/`::1` (loopback-only). So this adds
 * a parser that decodes the address, alongside a tiered command fallback that
 * mirrors `port-conflict.ts`:
 *
 *   1. `ss -tulnp`         — iproute2, ~always present; decoded address + PID.
 *   2. `/proc/net/{tcp,tcp6,udp,udp6}` — tool-free kernel socket table; address
 *      only (no cheap PID mapping), used when `ss` is absent (minimal images).
 *
 * Runs INSIDE the target via a CommandExecutor (SSH / bare / local) — never a
 * direct host exec — because the API may itself be containerized and the host's
 * real socket table is only visible through the executor for that server.
 */

/** Minimal command surface the scan needs. A full `CommandExecutor` satisfies it. */
export interface PortScanExecutor {
  exec(command: string, opts?: { timeout?: number }): Promise<string>;
}

export type PortProto = "tcp" | "udp";
export type PortFamily = "ipv4" | "ipv6";

export interface HostListener {
  proto: PortProto;
  family: PortFamily;
  /** Decoded bind address, e.g. "0.0.0.0", "127.0.0.1", "::", "::1", "192.168.1.5". */
  address: string;
  port: number;
  /**
   * Bound to a non-loopback interface. NECESSARY-BUT-NOT-SUFFICIENT for
   * internet-reachable: a host/cloud firewall (ufw, Hetzner, security group) can
   * still block a `0.0.0.0` bind. `reachable` is the confirmed off-box signal.
   */
  exposed: boolean;
  /** Owning PID when resolvable (ss path, usually root); null on the procfs fallback. */
  pid: number | null;
  /** Owning process name when resolvable; null otherwise. */
  process: string | null;
  /** Well-known service label for the port ("SSH", "HTTPS", "PostgreSQL"), or null. */
  service: string | null;
  /** Ports the platform expects to be open (SSH, edge 80/443) — so an exposed 443
   *  reads as normal, not alarming. */
  required?: boolean;
  /** Ports that should almost never face the internet (databases, Docker API). */
  sensitive?: boolean;
  /**
   * Off-box TCP reachability from the API host's vantage — filled by the API layer,
   * not the scan itself: true = dialed successfully (bind AND firewall allow it),
   * false = bound but blocked (e.g. a cloud firewall), null = not probed (loopback,
   * UDP, or a local target where an off-box dial is meaningless).
   */
  reachable?: boolean | null;
}

export interface PortScanResult {
  listeners: HostListener[];
  totalCount: number;
  exposedCount: number;
  /** Which tier produced the data — "ss" is richer (has PIDs). */
  source: "ss" | "procfs";
  /**
   * True when the scan actually read the socket table. False means every tier
   * was inconclusive (executor unusable / no tools + no procfs) — callers must
   * treat `scanned:false` as "no signal", never as "nothing is listening".
   */
  scanned: boolean;
  /** Set by the API layer once it has dialed the exposed ports from off-box.
   *  False = only the bind-based classification is available (no live target). */
  reachabilityProbed?: boolean;
  /** Exposed TCP ports confirmed reachable from off-box. */
  reachableCount?: number;
}

// `-t` tcp, `-u` udp, `-l` listening, `-n` numeric (no DNS/port-name lookups so
// the address column is a raw IP we can classify), `-p` process. No `-H`: older
// iproute2 lacks it and would error the whole command — we skip the header row
// in the parser instead. `|| true` so a missing `ss` yields "" (→ procfs) rather
// than a rejected exec.
const SS_CMD = "ss -tulnp 2>/dev/null || true";

// Tag each family so the parser knows which decoder + listen-state to apply.
// busybox `sh`/`cat`/`echo` only — present on every runtime image.
const PROC_CMD =
  'for f in tcp tcp6 udp udp6; do echo "##$f"; cat /proc/net/$f 2>/dev/null; done; true';

// procfs socket-state column: 0A = TCP_LISTEN; 07 = TCP_CLOSE, which is how the
// kernel represents an unconnected (bound, "listening") UDP socket.
const STATE_TCP_LISTEN = "0A";
const STATE_UDP_UNCONN = "07";

/**
 * Loopback-only bind? Anything else — `0.0.0.0`, `::`, a wildcard `*`, or a
 * specific interface IP (LAN or public) — is reachable off the loopback and so
 * counts as exposed. We over-report rather than under-report: for a security
 * check, calling a loopback bind "exposed" is a harmless false alarm, but hiding
 * a real exposure is not.
 */
export function isLoopbackAddress(address: string): boolean {
  if (!address) return false;
  if (address === "::1") return true;
  // IPv4-mapped IPv6, e.g. ::ffff:127.0.0.1
  if (address.startsWith("::ffff:")) return /^127\./.test(address.slice(7));
  return /^127\./.test(address);
}

function classify(address: string): boolean {
  return !isLoopbackAddress(address);
}

interface PortServiceInfo {
  service: string | null;
  required?: boolean;
  sensitive?: boolean;
}

/**
 * Well-known ports → friendly service label. `required` marks ports the platform
 * expects to be open (so an exposed 443 doesn't read as a scary finding);
 * `sensitive` marks ports that should almost never be internet-facing, so the UI
 * can escalate when one of these is actually reachable from off-box.
 */
const PORT_SERVICES: Record<number, PortServiceInfo> = {
  22: { service: "SSH", required: true },
  80: { service: "HTTP", required: true },
  443: { service: "HTTPS", required: true },
  25: { service: "SMTP" },
  587: { service: "SMTP (submission)" },
  465: { service: "SMTPS" },
  143: { service: "IMAP" },
  993: { service: "IMAPS" },
  110: { service: "POP3" },
  995: { service: "POP3S" },
  53: { service: "DNS" },
  123: { service: "NTP" },
  67: { service: "DHCP" },
  68: { service: "DHCP" },
  111: { service: "rpcbind" },
  631: { service: "IPP/CUPS" },
  3306: { service: "MySQL", sensitive: true },
  5432: { service: "PostgreSQL", sensitive: true },
  6379: { service: "Redis", sensitive: true },
  27017: { service: "MongoDB", sensitive: true },
  11211: { service: "Memcached", sensitive: true },
  9200: { service: "Elasticsearch", sensitive: true },
  9300: { service: "Elasticsearch (transport)", sensitive: true },
  5672: { service: "RabbitMQ", sensitive: true },
  15672: { service: "RabbitMQ (management)", sensitive: true },
  2375: { service: "Docker API (unencrypted)", sensitive: true },
  2376: { service: "Docker API (TLS)", sensitive: true },
  8080: { service: "HTTP (alt)" },
  8443: { service: "HTTPS (alt)" },
  3000: { service: "App (dev)" },
};

/** Friendly service info for a port. Pure — unknown ports return `{ service: null }`. */
export function describeService(port: number): PortServiceInfo {
  return PORT_SERVICES[port] ?? { service: null };
}

function makeListener(
  proto: PortProto,
  family: PortFamily,
  address: string,
  port: number,
  pid: number | null,
  process: string | null,
): HostListener {
  const svc = describeService(port);
  return {
    proto,
    family,
    address,
    port,
    exposed: classify(address),
    pid,
    process,
    service: svc.service,
    required: svc.required,
    sensitive: svc.sensitive,
    reachable: null,
  };
}

/** Decode a /proc/net/tcp IPv4 hex `local_address` (little-endian, per-byte). */
function decodeProcV4(hex: string): string {
  if (!/^[0-9A-Fa-f]{8}$/.test(hex)) return "";
  const b = [hex.slice(0, 2), hex.slice(2, 4), hex.slice(4, 6), hex.slice(6, 8)].map((h) =>
    parseInt(h, 16),
  );
  return `${b[3]}.${b[2]}.${b[1]}.${b[0]}`;
}

/**
 * Decode a /proc/net/tcp6 IPv6 hex `local_address`. The 16 bytes are stored as
 * four host-endian 32-bit words, so each 8-hex word is byte-reversed relative to
 * network order — undo that, then format (with `::` zero-run compression and
 * IPv4-mapped recognition).
 */
function decodeProcV6(hex: string): string {
  if (!/^[0-9A-Fa-f]{32}$/.test(hex)) return "";
  let net = "";
  for (let w = 0; w < 4; w++) {
    const word = hex.slice(w * 8, w * 8 + 8);
    net += word.slice(6, 8) + word.slice(4, 6) + word.slice(2, 4) + word.slice(0, 2);
  }
  net = net.toLowerCase();
  if (/^0{32}$/.test(net)) return "::";
  if (/^0{31}1$/.test(net)) return "::1";
  if (/^0{20}ffff/.test(net)) {
    const v4 = net.slice(24);
    const o = [v4.slice(0, 2), v4.slice(2, 4), v4.slice(4, 6), v4.slice(6, 8)].map((h) =>
      parseInt(h, 16),
    );
    return `::ffff:${o[0]}.${o[1]}.${o[2]}.${o[3]}`;
  }
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) groups.push((net.slice(i * 4, i * 4 + 4).replace(/^0+/, "") || "0"));
  // Collapse the longest run of "0" groups to "::".
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < groups.length; i++) {
    if (groups[i] === "0") {
      if (curStart === -1) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLen).join(":");
  return `${head}::${tail}`;
}

/** Split an `ss` "Local Address:Port" token into address + port + family. */
function parseSsLocal(local: string): { address: string; port: number; family: PortFamily } | null {
  let family: PortFamily = "ipv4";
  let host: string;
  let portStr: string;
  if (local.startsWith("[")) {
    family = "ipv6";
    const end = local.indexOf("]");
    if (end === -1) return null;
    host = local.slice(1, end);
    portStr = local.slice(end + 2); // skip "]:"
  } else {
    const colon = local.lastIndexOf(":");
    if (colon === -1) return null;
    host = local.slice(0, colon);
    portStr = local.slice(colon + 1);
    if (host.includes(":")) family = "ipv6"; // bare (bracket-less) IPv6, uncommon
  }
  const pct = host.indexOf("%"); // strip a zone id like fe80::1%eth0
  if (pct !== -1) host = host.slice(0, pct);
  const port = portStr === "*" ? 0 : parseInt(portStr, 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  return { address: host === "*" ? (family === "ipv6" ? "::" : "0.0.0.0") : host, port, family };
}

/**
 * Parse `ss -tulnp` output into listeners. Pure. Skips the header row and keeps
 * only listening sockets (TCP `LISTEN`, UDP `UNCONN`) so an outbound/ESTABLISHED
 * socket is never counted as an open port.
 */
export function parseSsListeners(ssOutput: string): HostListener[] {
  const out: HostListener[] = [];
  for (const rawLine of ssOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split(/\s+/);
    if (fields.length < 5) continue;
    const netid = fields[0].toLowerCase();
    if (netid !== "tcp" && netid !== "udp") continue; // skips header ("Netid ...")
    const state = fields[1].toUpperCase();
    if (state !== "LISTEN" && state !== "UNCONN") continue;
    const parsed = parseSsLocal(fields[4]);
    if (!parsed) continue;

    const procText = fields.slice(6).join(" ");
    const pidMatch = procText.match(/pid=(\d+)/);
    const nameMatch = procText.match(/"([^"]+)"/);

    out.push(
      makeListener(
        netid as PortProto,
        parsed.family,
        parsed.address,
        parsed.port,
        pidMatch ? parseInt(pidMatch[1], 10) : null,
        nameMatch ? nameMatch[1] : null,
      ),
    );
  }
  return out;
}

/**
 * Parse the tagged concatenation of /proc/net/{tcp,tcp6,udp,udp6} into listeners.
 * Pure. Each `##<family>` marker (emitted by `PROC_CMD`) switches the active
 * decoder + listen-state filter. No PID mapping — that would need an inode→fd
 * scan the ss path already covers.
 */
export function parseProcNetListeners(taggedText: string): HostListener[] {
  const out: HostListener[] = [];
  let proto: PortProto = "tcp";
  let family: PortFamily = "ipv4";
  let wantState = STATE_TCP_LISTEN;

  for (const rawLine of taggedText.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("##")) {
      const tag = line.slice(2).trim();
      proto = tag.startsWith("udp") ? "udp" : "tcp";
      family = tag.endsWith("6") ? "ipv6" : "ipv4";
      wantState = proto === "tcp" ? STATE_TCP_LISTEN : STATE_UDP_UNCONN;
      continue;
    }
    const fields = line.split(/\s+/);
    if (fields.length < 4) continue;
    if (fields[3] !== wantState) continue; // skips the "sl local_address ... st" header
    const local = fields[1];
    const colon = local.lastIndexOf(":");
    if (colon === -1) continue;
    const hexIp = local.slice(0, colon);
    const hexPort = local.slice(colon + 1);
    if (!/^[0-9A-Fa-f]{1,4}$/.test(hexPort)) continue;
    const port = parseInt(hexPort, 16);
    if (port <= 0) continue;
    const address = family === "ipv4" ? decodeProcV4(hexIp) : decodeProcV6(hexIp);
    if (!address) continue;
    out.push(makeListener(proto, family, address, port, null, null));
  }
  return out;
}

function finalize(listeners: HostListener[], source: "ss" | "procfs"): PortScanResult {
  // Exposed first, then by port, then loopback — the security-relevant rows lead.
  const sorted = [...listeners].sort((a, b) => {
    if (a.exposed !== b.exposed) return a.exposed ? -1 : 1;
    if (a.port !== b.port) return a.port - b.port;
    return a.address.localeCompare(b.address);
  });
  return {
    listeners: sorted,
    totalCount: sorted.length,
    exposedCount: sorted.filter((l) => l.exposed).length,
    source,
    scanned: true,
  };
}

async function tryExec(executor: PortScanExecutor, command: string): Promise<string | null> {
  try {
    return await executor.exec(command, { timeout: 10_000 });
  } catch {
    return null;
  }
}

/**
 * Enumerate every listening socket on the target and classify each exposed vs
 * loopback-only. Tiered (ss → procfs) so it works on both full and minimal
 * hosts. Never throws — an unusable executor yields `{ scanned:false }`.
 */
export async function scanPorts(executor: PortScanExecutor): Promise<PortScanResult> {
  const ssOut = await tryExec(executor, SS_CMD);
  if (ssOut) {
    const listeners = parseSsListeners(ssOut);
    if (listeners.length) return finalize(listeners, "ss");
  }

  const procOut = await tryExec(executor, PROC_CMD);
  if (procOut && procOut.includes("##")) {
    return finalize(parseProcNetListeners(procOut), "procfs");
  }

  return { listeners: [], totalCount: 0, exposedCount: 0, source: "procfs", scanned: false };
}
