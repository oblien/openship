/** Immutable Docker-config vhosts for the scheduler-managed OpenShip Edge. */

import { createHash } from "node:crypto";
import { buildEdgeImageRef } from "@repo/core";
import type { CommandExecutor } from "../../types";
import { sq } from "../git-clone";
import {
  SWARM_EDGE_INGRESS_LABEL,
  SWARM_EDGE_NETWORK_NAME,
  SWARM_EDGE_SERVICE_NAME,
} from "./edge";

const SITES_DIR = "/usr/local/openresty/nginx/conf/sites-enabled";
const CONFIG_STAGE_PREFIX = "/tmp/openship-swarm-edge-route.";
const CERT_SERVICE_PREFIX = "openship-edge-acme-";
const EDGE_CERT_VOLUME = "openship-edge-certs";
const EDGE_ACME_VOLUME = "openship-edge-acme";

type EdgeRouteExecutor = Pick<CommandExecutor, "exec" | "writeFile" | "rm">;

export interface SwarmEdgeRouteInput {
  domain: string;
  /** Full, stable Swarm service DNS identity — never a user supplied URL. */
  serviceDnsName: string;
  port: number;
}

export interface SwarmEdgeCertificateStatus {
  domain: string;
  expiresAt: string;
  verified: boolean;
}

export class SwarmEdgeRouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwarmEdgeRouteError";
  }
}

function assertDomain(value: string): string {
  const domain = value.trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(domain) || domain.includes("..")) {
    throw new SwarmEdgeRouteError("The Edge route domain is invalid.");
  }
  return domain;
}

function assertServiceDnsName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(name)) {
    throw new SwarmEdgeRouteError("The Edge route service DNS name is invalid.");
  }
  return name;
}

function assertPort(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new SwarmEdgeRouteError("The Edge route port must be from 1 to 65535.");
  }
  return value;
}

function domainSlug(domain: string): string {
  return `${domain.replaceAll(/[^a-z0-9]/g, "-").slice(0, 48)}-${createHash("sha256").update(domain).digest("hex").slice(0, 12)}`;
}

/** Deterministic mount target, exported for reconciliation and safe inspection. */
export function swarmEdgeRouteConfigTarget(domainInput: string): string {
  const domain = assertDomain(domainInput);
  return `${SITES_DIR}/${domainSlug(domain)}.conf`;
}

/** Safe complete vhost; values are separately constrained before interpolation. */
export function renderSwarmEdgeRoute(input: SwarmEdgeRouteInput, tls: boolean): string {
  const domain = assertDomain(input.domain);
  const service = assertServiceDnsName(input.serviceDnsName);
  const port = assertPort(input.port);
  const upstream = `http://${service}:${port}`;
  const common = `proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";`;
  const acme = `location /.well-known/acme-challenge/ {
        root /var/www/acme;
    }`;
  const meta = `# openship-swarm-edge-route domain=${domain} upstream=${upstream}`;
  if (!tls) return `${meta}
server {
    listen 80;
    server_name ${domain};

    ${acme}

    location / {
        proxy_pass ${upstream};
        ${common}
    }
}
`;
  return `${meta}
server {
    listen 80;
    server_name ${domain};

    ${acme}

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    server_name ${domain};

    ssl_certificate /etc/letsencrypt/live/${domain}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;

    location / {
        proxy_pass ${upstream};
        ${common}
    }
}
`;
}

type ServiceConfig = { name: string; target: string };

function parseServiceConfigs(value: string): ServiceConfig[] {
  if (!value.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SwarmEdgeRouteError("Docker returned unreadable OpenShip Edge config metadata.");
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as { ConfigName?: unknown; File?: { Name?: unknown } };
    return typeof record.ConfigName === "string" && typeof record.File?.Name === "string"
      ? [{ name: record.ConfigName, target: record.File.Name }]
      : [];
  });
}

/**
 * Replaces routes by Docker config + Edge service update. The update is the
 * reliable reload mechanism: the manager need never locate/exec a task
 * container, and a bad update leaves the prior config/task in place.
 */
export class SwarmEdgeRouteManager {
  constructor(private readonly executor: EdgeRouteExecutor) {}

  private async edgeConfigs(): Promise<ServiceConfig[]> {
    const output = await this.executor.exec(
      `docker service inspect ${sq(SWARM_EDGE_SERVICE_NAME)} --format '{{json .Spec.TaskTemplate.ContainerSpec.Configs}}'`,
    );
    return parseServiceConfigs(output);
  }

  private async createConfig(domain: string, content: string): Promise<string> {
    let stage: string | null = null;
    const configName = `openship-edge-route-${domainSlug(domain)}-${createHash("sha256").update(content).digest("hex").slice(0, 12)}`;
    try {
      stage = (await this.executor.exec(`umask 077 && mktemp -d ${CONFIG_STAGE_PREFIX}XXXXXX`)).trim();
      if (!new RegExp(`^${CONFIG_STAGE_PREFIX.replace(".", "\\.")}[A-Za-z0-9]+$`).test(stage)) {
        throw new SwarmEdgeRouteError("Docker manager returned an invalid Edge config staging directory.");
      }
      const path = `${stage}/route.conf`;
      await this.executor.writeFile(path, content);
      await this.executor.exec([
        "docker config create",
        `--label ${sq("com.openship.edge.route=true")}`,
        `--label ${sq(`com.openship.edge.domain=${domain}`)}`,
        sq(configName),
        sq(path),
      ].join(" "));
      return configName;
    } finally {
      if (stage) await this.executor.rm(stage).catch(() => {});
    }
  }

  private async replaceConfig(domain: string, content: string): Promise<void> {
    const target = swarmEdgeRouteConfigTarget(domain);
    const existing = (await this.edgeConfigs()).filter((config) => config.target === target);
    if (existing.some((config) => !config.name.startsWith("openship-edge-route-"))) {
      throw new SwarmEdgeRouteError(`A non-OpenShip Edge config already owns ${domain}; refusing to replace it.`);
    }
    const next = await this.createConfig(domain, content);
    try {
      await this.executor.exec([
        "docker service update --detach=false",
        ...existing.map((config) => `--config-rm ${sq(config.name)}`),
        `--config-add ${sq(`source=${next},target=${target}`)}`,
        sq(SWARM_EDGE_SERVICE_NAME),
      ].join(" "));
    } catch (error) {
      await this.executor.exec(`docker config rm ${sq(next)} >/dev/null 2>&1 || true`).catch(() => {});
      throw error;
    }
    await Promise.all(existing.map((config) => this.executor.exec(`docker config rm ${sq(config.name)} >/dev/null 2>&1 || true`).catch(() => {})));
  }

  async register(input: SwarmEdgeRouteInput, opts: { tls?: boolean } = {}): Promise<void> {
    const domain = assertDomain(input.domain);
    await this.replaceConfig(domain, renderSwarmEdgeRoute({ ...input, domain }, opts.tls ?? false));
  }

  async remove(domainInput: string): Promise<void> {
    const domain = assertDomain(domainInput);
    const target = swarmEdgeRouteConfigTarget(domain);
    const existing = (await this.edgeConfigs()).filter((config) => config.target === target);
    if (existing.length === 0) return;
    if (existing.some((config) => !config.name.startsWith("openship-edge-route-"))) {
      throw new SwarmEdgeRouteError(`A non-OpenShip Edge config already owns ${domain}; refusing to remove it.`);
    }
    await this.executor.exec([
      "docker service update --detach=false",
      ...existing.map((config) => `--config-rm ${sq(config.name)}`),
      sq(SWARM_EDGE_SERVICE_NAME),
    ].join(" "));
    await Promise.all(existing.map((config) => this.executor.exec(`docker config rm ${sq(config.name)} >/dev/null 2>&1 || true`).catch(() => {})));
  }

  async provisionTls(
    input: SwarmEdgeRouteInput,
    opts: { image?: string; ingressLabel?: string } = {},
  ): Promise<SwarmEdgeCertificateStatus> {
    const domain = assertDomain(input.domain);
    const image = opts.image ?? buildEdgeImageRef();
    const ingressLabel = opts.ingressLabel ?? SWARM_EDGE_INGRESS_LABEL;
    const suffix = createHash("sha256").update(domain).digest("hex").slice(0, 16);
    // A unique job sidesteps a stale service left behind by a manager restart;
    // the per-domain API lock still serializes actual ACME orders.
    const job = `${CERT_SERVICE_PREFIX}${suffix}-${Date.now().toString(36)}`;
    // The HTTP route must exist before this task starts. It writes challenge and
    // cert files to the exact persistent volumes used by the pinned Edge task.
    try {
      await this.executor.exec([
        "docker service create",
        `--name ${sq(job)}`,
        `--constraint ${sq(`node.labels.${ingressLabel} == true`)}`,
        "--restart-condition none",
        `--network ${sq(SWARM_EDGE_NETWORK_NAME)}`,
        `--mount ${sq(`type=volume,source=${EDGE_CERT_VOLUME},target=/etc/letsencrypt`)}`,
        `--mount ${sq(`type=volume,source=${EDGE_ACME_VOLUME},target=/var/www/acme`)}`,
        sq(image),
        "certbot certonly --webroot -w /var/www/acme",
        `--cert-name ${sq(domain)}`,
        `-d ${sq(domain)}`,
        "--register-unsafely-without-email --agree-tos --non-interactive",
      ].join(" "));
      await this.executor.exec(`for i in $(seq 1 90); do s=$(docker service ps ${sq(job)} --no-trunc --format '{{.CurrentState}}' | head -1); case "$s" in Complete*) exit 0;; *Failed*|*Rejected*) echo "$s" >&2; exit 1;; esac; sleep 1; done; exit 1`);
    } finally {
      await this.executor.exec(`docker service rm ${sq(job)} >/dev/null 2>&1 || true`).catch(() => {});
    }
    await this.replaceConfig(domain, renderSwarmEdgeRoute({ ...input, domain }, true));
    const certificate = await this.certificateStatus(domain, opts);
    if (!certificate.verified) {
      throw new SwarmEdgeRouteError(`OpenShip Edge issued a certificate for ${domain} but could not verify it on the ingress volume.`);
    }
    return certificate;
  }

  /**
   * Reads certificate metadata through a short-lived pinned Swarm task. The
   * certificate volume is node-local by design, so inspecting it from the
   * manager host (or an arbitrary task) would be incorrect after a reschedule.
   */
  async certificateStatus(
    domainInput: string,
    opts: { image?: string; ingressLabel?: string } = {},
  ): Promise<SwarmEdgeCertificateStatus> {
    const domain = assertDomain(domainInput);
    const image = opts.image ?? buildEdgeImageRef();
    const ingressLabel = opts.ingressLabel ?? SWARM_EDGE_INGRESS_LABEL;
    const suffix = createHash("sha256").update(domain).digest("hex").slice(0, 16);
    const job = `${CERT_SERVICE_PREFIX}inspect-${suffix}-${Date.now().toString(36)}`;
    try {
      await this.executor.exec([
        "docker service create",
        `--name ${sq(job)}`,
        `--constraint ${sq(`node.labels.${ingressLabel} == true`)}`,
        "--restart-condition none",
        `--mount ${sq(`type=volume,source=${EDGE_CERT_VOLUME},target=/etc/letsencrypt,readonly`)}`,
        sq(image),
        "certbot certificates",
        `--cert-name ${sq(domain)}`,
      ].join(" "));
      await this.executor.exec(`for i in $(seq 1 30); do s=$(docker service ps ${sq(job)} --no-trunc --format '{{.CurrentState}}' | head -1); case "$s" in Complete*) exit 0;; *Failed*|*Rejected*) exit 1;; esac; sleep 1; done; exit 1`);
      const output = await this.executor.exec(`docker service logs ${sq(job)} 2>&1 || true`);
      const match = output.match(/^\s*Expiry Date:\s*(.+?)\s*\(VALID:/mi);
      const expiresAt = match?.[1] ? new Date(match[1]).toISOString() : "";
      return { domain, expiresAt, verified: !!expiresAt };
    } catch {
      return { domain, expiresAt: "", verified: false };
    } finally {
      await this.executor.exec(`docker service rm ${sq(job)} >/dev/null 2>&1 || true`).catch(() => {});
    }
  }
}
