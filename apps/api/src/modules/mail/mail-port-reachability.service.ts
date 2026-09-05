/**
 * Public mail-port health.
 *
 * This combines two different facts without conflating them:
 *   1. a listener scan on the mail host; and
 *   2. an off-box TCP connection from the Openship control plane to the public
 *      DNS address.
 *
 * The first catches a stopped daemon or loopback-only bind. The second catches
 * host/provider firewalls and NAT rules. Neither fact alone can diagnose both.
 */

import { scanPorts, type CommandExecutor, type TcpProbeFailure } from "@repo/adapters";
import { isSyntheticDnsAddress } from "../../lib/dns-address";
import { probePortsFromControlPlane } from "../../lib/port-reachability";
import { createPublicDnsResolver } from "../../lib/public-dns";

export const REQUIRED_PUBLIC_MAIL_PORTS = [
  { key: "smtp", port: 25, label: "SMTP inbound" },
  { key: "smtps", port: 465, label: "SMTP submission (TLS)" },
  { key: "submission", port: 587, label: "SMTP submission (STARTTLS)" },
  { key: "imaps", port: 993, label: "IMAP (TLS)" },
] as const;

/** Mail-client ports. Unlike inbound SMTP, these are not filtered by cloud outbound-25 throttles. */
export const CLIENT_PUBLIC_MAIL_PORTS = [465, 587, 993] as const;

export const SMTP_INBOUND_PORT = 25;

/**
 * Why a public :25 timeout is often not a setup wall: AWS (and some other
 * clouds) filter TCP 25 originating FROM the instance. The wizard probe runs
 * on the Openship control plane, which on a single-box self-host is that same
 * instance, so the "public" dial of `mail.example.com:25` is actually outbound
 * port 25 from the box. That times out even when inbound MX from the internet
 * would succeed, and even when operators send through SES / another relay.
 */
export const SMTP_INBOUND_SOFT_BLOCK_DETAIL =
  "Inbound TCP 25 could not be verified from the control plane. Many clouds " +
  "(especially AWS) filter instance-originated port 25, so this probe can time " +
  "out even when inbound MX delivery works. SMTP submission (465/587) and IMAP " +
  "(993) are reachable. Route sending through an SMTP provider on the Sending " +
  "tab if outbound port 25 is blocked.";

export type MailPortReachabilityStatus =
  | "reachable"
  | "blocked"
  | "not_listening"
  | "not_exposed"
  | "unknown";

export interface MailPortReachabilityCheck {
  key: (typeof REQUIRED_PUBLIC_MAIL_PORTS)[number]["key"];
  port: number;
  label: string;
  status: MailPortReachabilityStatus;
  listening: boolean | null;
  exposed: boolean | null;
  reachable: boolean | null;
  failure?: TcpProbeFailure;
  detail?: string;
}

export interface MailPortReachability {
  hostname: string;
  /** The public-DNS address dialled from the control plane. */
  address: string | null;
  checkedAt: number;
  status: "ok" | "fail" | "unknown";
  ports: MailPortReachabilityCheck[];
  detail?: string;
}

/**
 * True when :25 is listening on a public bind, the control-plane probe timed
 * out, and every mail-client port completed a TCP handshake. Local bind
 * failures (not listening / loopback-only) stay hard failures.
 */
export function isControlPlaneSmtpInboundSoftBlock(
  ports: readonly MailPortReachabilityCheck[],
): boolean {
  const smtp = ports.find((port) => port.port === SMTP_INBOUND_PORT);
  if (!smtp || smtp.status !== "blocked" || !smtp.listening || !smtp.exposed) {
    return false;
  }
  return CLIENT_PUBLIC_MAIL_PORTS.every(
    (port) => ports.find((row) => row.port === port)?.status === "reachable",
  );
}

interface ReachabilityDependencies {
  resolvePublicAddress?: (hostname: string) => Promise<string>;
  scan?: typeof scanPorts;
  probe?: typeof probePortsFromControlPlane;
}

export interface MailPortReachabilityOptions {
  /** Coalesce and cache checks for this server. Omit for an uncached probe. */
  cacheKey?: string;
  /** Ignore a prior health reading, e.g. immediately after setup or a timeout. */
  force?: boolean;
  /** Tests inject deterministic network dependencies through this seam. */
  dependencies?: ReachabilityDependencies;
}

const HEALTH_CACHE_TTL_MS = 60_000;
const healthCache = new Map<string, { expiresAt: number; value: Promise<MailPortReachability> }>();

/** Resolve through public DNS so the mail host's `/etc/hosts` cannot redirect us. */
export async function resolvePublicMailAddress(hostname: string): Promise<string> {
  const resolver = createPublicDnsResolver();

  const v4 = await resolver.resolve4(hostname).catch(() => [] as string[]);
  const usableV4 = v4.find((address) => !isSyntheticDnsAddress(address));
  if (usableV4) return usableV4;
  if (v4.length > 0) {
    throw new Error(
      `Public DNS returned only synthetic addresses for ${hostname}; disable the fake-IP DNS proxy and retry.`,
    );
  }

  const v6 = await resolver.resolve6(hostname).catch(() => [] as string[]);
  const usableV6 = v6.find((address) => !isSyntheticDnsAddress(address));
  if (usableV6) return usableV6;
  if (v6.length > 0) {
    throw new Error(
      `Public DNS returned only synthetic addresses for ${hostname}; disable the fake-IP DNS proxy and retry.`,
    );
  }

  throw new Error(`Public DNS has no A or AAAA address for ${hostname}.`);
}

export async function checkMailPortReachability(
  executor: CommandExecutor,
  hostname: string,
  options: MailPortReachabilityOptions = {},
): Promise<MailPortReachability> {
  const cacheId = options.cacheKey ? `${options.cacheKey}:${hostname.toLowerCase()}` : null;
  const now = Date.now();
  if (cacheId && !options.force) {
    const cached = healthCache.get(cacheId);
    if (cached && cached.expiresAt > now) return cached.value;
  }

  const value = runMailPortReachability(executor, hostname, options.dependencies);
  if (cacheId) {
    healthCache.set(cacheId, { expiresAt: now + HEALTH_CACHE_TTL_MS, value });
    void value.catch(() => {
      // A forced refresh can replace an in-flight entry. An older rejected
      // promise must not delete the newer healthy reading.
      if (healthCache.get(cacheId)?.value === value) healthCache.delete(cacheId);
    });
  }
  return value;
}

async function runMailPortReachability(
  executor: CommandExecutor,
  hostname: string,
  dependencies: ReachabilityDependencies = {},
): Promise<MailPortReachability> {
  const scan = dependencies.scan ?? scanPorts;
  const probe = dependencies.probe ?? probePortsFromControlPlane;
  const resolvePublicAddress = dependencies.resolvePublicAddress ?? resolvePublicMailAddress;
  const checkedAt = Date.now();
  const listenerScan = await scan(executor);

  let address: string | null = null;
  let resolutionDetail: string | undefined;
  try {
    address = await resolvePublicAddress(hostname);
  } catch (err) {
    resolutionDetail = err instanceof Error ? err.message : "Public DNS lookup failed.";
  }

  const externallyProbeable = REQUIRED_PUBLIC_MAIL_PORTS.filter(
    ({ port }) =>
      listenerScan.scanned &&
      listenerScan.listeners.some(
        (listener) => listener.proto === "tcp" && listener.port === port && listener.exposed,
      ),
  ).map(({ port }) => port);
  const observations = address
    ? await probe(address, externallyProbeable, { timeoutMs: 1_500, concurrency: 4, maxPorts: 4 })
    : [];
  const byPort = new Map(observations.map((observation) => [observation.port, observation.result]));

  const ports: MailPortReachabilityCheck[] = REQUIRED_PUBLIC_MAIL_PORTS.map((definition) => {
    if (!listenerScan.scanned) {
      return {
        ...definition,
        status: "unknown",
        listening: null,
        exposed: null,
        reachable: null,
        detail: "The mail host listener table could not be read.",
      };
    }

    const listeners = listenerScan.listeners.filter(
      (listener) => listener.proto === "tcp" && listener.port === definition.port,
    );
    if (listeners.length === 0) {
      return {
        ...definition,
        status: "not_listening",
        listening: false,
        exposed: false,
        reachable: false,
        detail: `No TCP process is listening on port ${definition.port}.`,
      };
    }
    if (!listeners.some((listener) => listener.exposed)) {
      return {
        ...definition,
        status: "not_exposed",
        listening: true,
        exposed: false,
        reachable: false,
        detail: `Port ${definition.port} is bound only to loopback on the mail host.`,
      };
    }
    if (!address) {
      return {
        ...definition,
        status: "unknown",
        listening: true,
        exposed: true,
        reachable: null,
        detail: resolutionDetail,
      };
    }

    const observation = byPort.get(definition.port);
    if (!observation) {
      return {
        ...definition,
        status: "unknown",
        listening: true,
        exposed: true,
        reachable: null,
        detail: "The off-box TCP probe did not return a result.",
      };
    }
    if (observation.ok) {
      return {
        ...definition,
        status: "reachable",
        listening: true,
        exposed: true,
        reachable: true,
      };
    }
    return {
      ...definition,
      status: "blocked",
      listening: true,
      exposed: true,
      reachable: false,
      failure: observation.reason,
      detail: observation.message,
    };
  });

  const smtpInboundSoftBlock = isControlPlaneSmtpInboundSoftBlock(ports);
  const hardFailure = ports.some((port) => {
    if (smtpInboundSoftBlock && port.port === SMTP_INBOUND_PORT && port.status === "blocked") {
      return false;
    }
    return (
      port.status === "blocked" || port.status === "not_listening" || port.status === "not_exposed"
    );
  });
  const unknown = ports.some((port) => port.status === "unknown");
  const detail = [
    resolutionDetail,
    smtpInboundSoftBlock ? SMTP_INBOUND_SOFT_BLOCK_DETAIL : undefined,
  ]
    .filter((part): part is string => Boolean(part))
    .join(" ");
  return {
    hostname,
    address,
    checkedAt,
    status: hardFailure ? "fail" : unknown ? "unknown" : "ok",
    ports,
    ...(detail ? { detail } : {}),
  };
}

export function mailReachabilityFailureMessage(
  result: MailPortReachability,
  onlyPorts?: readonly number[],
): string {
  const selected = onlyPorts
    ? result.ports.filter((port) => onlyPorts.includes(port.port))
    : result.ports;
  const failed = selected.filter(
    (port) => port.status !== "reachable" && port.status !== "unknown",
  );
  if (failed.length === 0) {
    return result.detail ?? "Public mail-port reachability could not be verified.";
  }

  const local = failed.filter(
    (port) => port.status === "not_listening" || port.status === "not_exposed",
  );
  const blocked = failed.filter((port) => port.status === "blocked");
  const messages: string[] = [];
  if (local.length > 0) {
    const ports = local.map((port) => `${port.port} (${port.status.replace("_", " ")})`).join(", ");
    messages.push(
      `Local mail listener problem: ${ports}. Start the relevant mail daemon and make sure it binds to a non-loopback interface.`,
    );
  }
  if (blocked.length > 0) {
    const ports = blocked.map((port) => port.port).join(", ");
    messages.push(
      `The mail daemon is listening, but TCP ${ports} cannot be reached through the public address. ` +
        `Allow the port in both the host firewall and your cloud provider firewall/security ` +
        `list/security group/NSG, then retry.`,
    );
  }
  return messages.join(" ");
}

/** Test/process lifecycle hook; production callers normally rely on the TTL. */
export function clearMailPortReachabilityCache(): void {
  healthCache.clear();
}
