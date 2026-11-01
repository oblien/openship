import { AppError } from "@repo/core";
import { z } from "zod";
import type { IngressConnection, IngressHostname } from "@repo/db";
import type { IngressOwnership } from "@repo/db/schema";
import { cloudflareDnsProvider } from "../dns/providers/cloudflare.provider";
import type { DnsRecord } from "../dns/types";
import { cloudflareFetch, cloudflareList, CloudflareApiError } from "../../lib/cloudflare-api";

export interface Tunnel {
  id: string;
  name: string;
  config_src?: string;
  remote_config?: boolean;
  status?: string;
}
export interface AccessPolicy {
  id: string;
  name: string;
  decision: string;
}
// The account-wide list includes launcher, SaaS and private applications that
// have no primary domain. Validate the fields we inspect without requiring the
// hostname or audience of a self-hosted application on every application type.
const accessAppSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  type: z.string().optional(),
  domain: z.string().optional(),
  aud: z.string().optional(),
  policies: z.array(z.union([z.string(), z.object({ id: z.string() })])).optional(),
  destinations: z
    .array(
      z.object({
        type: z.string().optional(),
        uri: z.string().optional(),
        overrides: z.array(z.unknown()).optional(),
      }),
    )
    .optional(),
  self_hosted_domains: z.array(z.string()).optional(),
});
type AccessApp = z.infer<typeof accessAppSchema>;
function parseAccessApp(value: unknown): AccessApp {
  const parsed = accessAppSchema.safeParse(value);
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") || "application";
    throw new CloudflareApiError(
      502,
      `The API returned invalid Access application data (${field}). Review Access applications in Cloudflare and retry.`,
    );
  }
  return parsed.data;
}

export interface IngressRule {
  hostname?: string;
  service: string;
  path?: string;
  originRequest?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface TunnelConfig {
  ingress: IngressRule[];
  [key: string]: unknown;
}
export type OwnershipSave = (value: IngressOwnership, phase: string) => Promise<void>;
const conflict = (message: string): never => {
  throw new AppError(message, 409, "INGRESS_PROVIDER_CONFLICT");
};
/** Normalize provider-added empty originRequest objects; retain every substantive
 * field so a manual edit cannot be mistaken for our last accepted rule. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(
        ([, v]) =>
          v !== undefined &&
          !(v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0),
      )
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function mergeIngress(
  config: TunnelConfig,
  hostname: string,
  previous: IngressOwnership,
  next: IngressRule | null,
): TunnelConfig {
  const rules = config.ingress;
  if (
    !Array.isArray(rules) ||
    !rules.length ||
    rules.at(-1)?.hostname ||
    rules.at(-1)?.path ||
    !rules.at(-1)?.service
  )
    conflict(
      "The tunnel needs a final catch-all rule. Fix its configuration in Cloudflare, then retry.",
    );
  const matches = rules.filter((r) => r.hostname?.toLowerCase() === hostname);
  if (
    matches.length > 1 ||
    matches.some(
      (r) =>
        ![previous.rule, previous.nextRule].some(
          (owned) => owned && canonical(owned) === canonical(r),
        ),
    )
  )
    conflict(
      `The tunnel rule for ${hostname} was created or changed outside Openship. Review it in Cloudflare before retrying.`,
    );
  // Inserting below a wildcard would silently send this hostname elsewhere.
  if (
    !matches.length &&
    next &&
    rules.some((r) => r.hostname?.startsWith("*.") && hostname.endsWith(r.hostname.slice(1)))
  )
    conflict(
      `A wildcard tunnel rule already covers ${hostname}. Review it in Cloudflare before connecting this hostname.`,
    );
  const copy = rules.filter((r) => r.hostname?.toLowerCase() !== hostname);
  if (next)
    copy.splice(
      matches.length ? Math.min(rules.indexOf(matches[0]), copy.length - 1) : copy.length - 1,
      0,
      next,
    );
  return { ...config, ingress: copy };
}
function covers(pattern: string, host: string): boolean {
  const name = pattern.toLowerCase().split("/")[0];
  return name === host || (name.startsWith("*.") && host.endsWith(name.slice(1)));
}
function appCovers(app: AccessApp, host: string): boolean {
  return [
    app.domain,
    ...(app.self_hosted_domains ?? []),
    ...(app.destinations ?? []).filter((d) => d.type === "public").map((d) => d.uri ?? ""),
  ].some((name) => name !== undefined && covers(name, host));
}
function policyIds(app: AccessApp) {
  return (app.policies ?? []).map((p) => (typeof p === "string" ? p : p.id)).sort();
}

/** Provider operations accept persisted ownership and checkpoint BEFORE writes.
 * They never adopt resources by hostname alone. No API token leaves this module. */
export class CloudflareIngress {
  constructor(
    private readonly token: string,
    readonly accountId: string,
  ) {}
  private path(suffix: string) {
    return `/accounts/${encodeURIComponent(this.accountId)}${suffix}`;
  }
  private get<T>(suffix: string, options?: RequestInit): Promise<T> {
    return cloudflareFetch<T>(this.token, this.path(suffix), options);
  }
  private list<T>(suffix: string): Promise<T[]> {
    return cloudflareList<T>(this.token, this.path(suffix));
  }
  tunnels() {
    return this.list<Tunnel>("/cfd_tunnel?is_deleted=false");
  }
  policies() {
    return this.list<AccessPolicy>("/access/policies");
  }
  async tunnel(id: string): Promise<Tunnel> {
    const tunnel = await this.get<Tunnel>(`/cfd_tunnel/${encodeURIComponent(id)}`);
    if (tunnel.config_src !== "cloudflare" && tunnel.remote_config !== true)
      throw new AppError(
        "This tunnel uses a local configuration file. Use a remotely managed tunnel, or convert it in Cloudflare before connecting it.",
        400,
        "INGRESS_LOCAL_TUNNEL",
      );
    return tunnel;
  }
  async findTunnel(name: string): Promise<Tunnel | undefined> {
    const matches = (await this.tunnels()).filter((t) => t.name === name);
    if (matches.length > 1) conflict("Several tunnels match this setup. Select one explicitly.");
    return matches[0];
  }
  async createTunnel(name: string): Promise<Tunnel> {
    return (
      (await this.findTunnel(name)) ??
      this.get<Tunnel>("/cfd_tunnel", {
        method: "POST",
        body: JSON.stringify({ name, config_src: "cloudflare" }),
      })
    );
  }
  tokenForTunnel(id: string): Promise<string> {
    return this.get<string>(`/cfd_tunnel/${encodeURIComponent(id)}/token`);
  }
  private async configuration(id: string): Promise<TunnelConfig | null> {
    const response = await this.get<{ config: TunnelConfig | null }>(
      `/cfd_tunnel/${encodeURIComponent(id)}/configurations`,
    );
    if (response?.config === null) return null;
    if (!response?.config || !Array.isArray(response.config.ingress))
      throw new CloudflareApiError(502, "The tunnel configuration could not be read.");
    return response.config;
  }
  async config(id: string): Promise<TunnelConfig> {
    const config = await this.configuration(id);
    if (!config) throw new CloudflareApiError(502, "The tunnel has no configuration yet.");
    return config;
  }
  async initializeTunnel(id: string): Promise<void> {
    let config: TunnelConfig | null;
    try {
      config = await this.configuration(id);
    } catch (error) {
      if (error instanceof CloudflareApiError && error.providerStatus === 404) config = null;
      else throw error;
    }
    if (config?.ingress.length) return;
    await this.get(`/cfd_tunnel/${id}/configurations`, {
      method: "PUT",
      body: JSON.stringify({ config: { ...config, ingress: [{ service: "http_status:404" }] } }),
    });
  }
  async rule(
    host: IngressHostname,
    connection: IngressConnection,
    ownership: IngressOwnership,
    save: OwnershipSave,
    remove = false,
  ): Promise<void> {
    let config: TunnelConfig;
    try {
      config = await this.config(connection.tunnelId!);
    } catch (error) {
      if (remove && error instanceof CloudflareApiError && error.providerStatus === 404) {
        delete ownership.rule;
        delete ownership.nextRule;
        await save(ownership, "access");
        return;
      }
      throw error;
    }
    const rule: IngressRule | null = remove
      ? null
      : {
          hostname: host.hostname,
          service: `http://127.0.0.1:${connection.edgePort}`,
          ...(host.accessPolicyId
            ? {
                originRequest: {
                  access: {
                    required: true,
                    teamName: ownership.teamName,
                    audTag: [ownership.appAud],
                  },
                },
              }
            : {}),
        };
    const next = mergeIngress(config, host.hostname, ownership, rule);
    if (canonical(next) === canonical(config)) return;
    if (rule) {
      ownership.nextRule = rule;
      await save(ownership, "tunnel");
    }
    await this.get(`/cfd_tunnel/${connection.tunnelId}/configurations`, {
      method: "PUT",
      body: JSON.stringify({ config: next }),
    });
    const actual = await this.config(connection.tunnelId!);
    const saved = actual.ingress.filter((r) => r.hostname === host.hostname);
    if (rule ? saved.length !== 1 || canonical(saved[0]) !== canonical(rule) : saved.length !== 0)
      conflict(
        "The tunnel changed while Openship was updating it. Review its configuration and retry.",
      );
    if (rule) ownership.rule = rule;
    else delete ownership.rule;
    delete ownership.nextRule;
    await save(ownership, "dns");
  }
  async zone(hostname: string): Promise<{ id: string; name: string }> {
    const zone = await cloudflareDnsProvider.findZone(
      { apiToken: this.token, accountId: this.accountId },
      hostname,
    );
    if (zone) return zone;
    throw new AppError(
      "This credential cannot manage the hostname's DNS zone in the selected Cloudflare account. Check its Zone Read and DNS Edit permissions.",
      400,
      "INGRESS_ZONE_UNAVAILABLE",
    );
  }
  private marker(host: IngressHostname) {
    return `Managed by Openship (${host.id})`;
  }
  private async records(host: IngressHostname, ownership: IngressOwnership) {
    if (!ownership.zoneId) ownership.zoneId = (await this.zone(host.hostname)).id;
    return cloudflareDnsProvider.listRecords({ apiToken: this.token }, ownership.zoneId, {
      name: host.hostname,
    });
  }
  async dns(
    host: IngressHostname,
    connection: IngressConnection,
    ownership: IngressOwnership,
    save: OwnershipSave,
    remove = false,
  ): Promise<void> {
    const records = await this.records(host, ownership);
    // A name-filtered list cannot distinguish deletion from a manual rename.
    // Keep the ownership receipt until a lookup by its saved ID confirms absence.
    if (ownership.dnsId && !records.some((r) => r.id === ownership.dnsId)) {
      let existing: DnsRecord | undefined;
      try {
        existing = await cloudflareFetch<DnsRecord>(
          this.token,
          `/zones/${ownership.zoneId}/dns_records/${encodeURIComponent(ownership.dnsId)}`,
        );
      } catch (error) {
        if (!(error instanceof CloudflareApiError && error.providerStatus === 404)) throw error;
      }
      if (existing)
        conflict(
          `The DNS record for ${host.hostname} was moved or changed outside Openship. Restore it or remove it before retrying.`,
        );
    }
    const marker = this.marker(host),
      content = `${connection.tunnelId}.cfargotunnel.com`;
    const ours = records.filter(
      (r) =>
        (r.id === ownership.dnsId || ownership.dnsIntent) &&
        r.comment === marker &&
        r.type === "CNAME" &&
        r.name === host.hostname &&
        r.content === content &&
        r.proxied,
    );
    if (
      ownership.dnsId &&
      records.some((r) => r.id === ownership.dnsId) &&
      !ours.some((r) => r.id === ownership.dnsId)
    )
      conflict(
        `The DNS record for ${host.hostname} was changed outside Openship. Restore it or remove it before retrying.`,
      );
    if (ours.length > 1)
      conflict(
        `Several managed DNS records exist for ${host.hostname}. Review them before retrying.`,
      );
    if (remove) {
      for (const record of ours)
        await cloudflareDnsProvider.deleteRecord(
          { apiToken: this.token },
          ownership.zoneId!,
          record.id,
        );
      delete ownership.dnsId;
      delete ownership.dnsIntent;
      await save(ownership, "tunnel");
      return;
    }
    if (records.some((r) => !ours.includes(r) && ["A", "AAAA", "CNAME"].includes(r.type)))
      conflict(
        `DNS already points ${host.hostname} elsewhere. Openship will not replace an existing record. Remove that record in Cloudflare, then retry.`,
      );
    if (!ours.length) {
      ownership.dnsIntent = true;
      await save(ownership, "dns");
      const record = await cloudflareFetch<DnsRecord>(
        this.token,
        `/zones/${ownership.zoneId}/dns_records`,
        {
          method: "POST",
          body: JSON.stringify({
            type: "CNAME",
            name: host.hostname,
            content,
            proxied: true,
            ttl: 1,
            comment: marker,
          }),
        },
      );
      if (!record?.id)
        throw new CloudflareApiError(502, "The DNS record could not be confirmed. Retry setup.");
      ownership.dnsId = record.id;
    } else ownership.dnsId = ours[0].id;
    await save(ownership, "ready");
  }
  private async hydrateApp(app: AccessApp): Promise<AccessApp> {
    const detail = await this.get<AccessApp>(`/access/apps/${encodeURIComponent(app.id)}`);
    const policies = await this.list<{ id: string }>(
      `/access/apps/${encodeURIComponent(app.id)}/policies`,
    );
    return parseAccessApp({ ...detail, policies: policies.map((p) => ({ id: p.id })) });
  }
  async access(
    host: IngressHostname,
    ownership: IngressOwnership,
    save: OwnershipSave,
  ): Promise<void> {
    if (!host.accessPolicyId) return;
    const policy = await this.get<AccessPolicy>(`/access/policies/${host.accessPolicyId}`);
    if (!["allow", "non_identity"].includes(policy.decision))
      throw new AppError(
        "Choose an Allow or Service Auth reusable Access policy. Bypass policies cannot protect this hostname.",
        400,
        "INGRESS_ACCESS_POLICY",
      );
    const organization = await this.get<{ auth_domain: string }>("/access/organizations");
    const teamName = organization.auth_domain?.replace(/\.cloudflareaccess\.com$/, "");
    if (!teamName || !/^[a-zA-Z0-9-]+$/.test(teamName))
      throw new AppError(
        "Set up a Cloudflare Zero Trust organization before enabling Access.",
        400,
        "INGRESS_ACCESS_ORGANIZATION",
      );
    const apps = (await this.list<unknown>("/access/apps")).map(parseAccessApp);
    const name = `Openship ${host.id}`;
    let app = apps.find(
      (a) =>
        a.id === ownership.appId ||
        (ownership.appIntent && a.name === name && a.domain === host.hostname),
    );
    if (app) app = await this.hydrateApp(app);
    if (
      app &&
      (app.name !== name ||
        app.domain !== host.hostname ||
        app.type !== "self_hosted" ||
        app.destinations?.some((d) => d.uri !== host.hostname || d.overrides?.length) ||
        app.self_hosted_domains?.some((d) => d !== host.hostname) ||
        policyIds(app).some(
          (id) =>
            id !== ownership.appPolicyId &&
            id !== ownership.appNextPolicyId &&
            id !== host.accessPolicyId,
        ))
    )
      conflict(
        `The Access application for ${host.hostname} changed outside Openship. Review it before retrying.`,
      );
    if (apps.some((a) => a.id !== app?.id && appCovers(a, host.hostname)))
      conflict(
        `An existing Access application covers ${host.hostname}. Openship will not replace or adopt it.`,
      );
    if (!app || canonical(policyIds(app)) !== canonical([host.accessPolicyId])) {
      if (!app) ownership.appIntent = true;
      ownership.appNextPolicyId = host.accessPolicyId;
      await save(ownership, "access");
      app = parseAccessApp(
        await this.get<unknown>(`/access/apps${app ? `/${app.id}` : ""}`, {
          method: app ? "PUT" : "POST",
          body: JSON.stringify({
            type: "self_hosted",
            name,
            domain: host.hostname,
            destinations: [{ type: "public", uri: host.hostname }],
            session_duration: "24h",
            policies: [{ id: host.accessPolicyId, precedence: 1 }],
          }),
        }),
      );
    }
    if (app?.id) app = await this.hydrateApp(app);
    if (!app?.id || !app.aud || canonical(policyIds(app)) !== canonical([host.accessPolicyId]))
      throw new CloudflareApiError(
        502,
        "The Access application did not confirm its policy. The hostname has not been published.",
      );
    ownership.appId = app.id;
    ownership.appAud = app.aud;
    ownership.appPolicyId = host.accessPolicyId;
    delete ownership.appNextPolicyId;
    ownership.teamName = teamName;
    await save(ownership, "tunnel");
  }
  async removeAccess(
    host: IngressHostname,
    ownership: IngressOwnership,
    save: OwnershipSave,
  ): Promise<void> {
    if (!ownership.appId && !ownership.appIntent) return;
    const apps = (await this.list<unknown>("/access/apps")).map(parseAccessApp);
    let app = apps.find(
      (a) =>
        a.id === ownership.appId ||
        (ownership.appIntent && a.name === `Openship ${host.id}` && a.domain === host.hostname),
    );
    if (app) {
      app = await this.hydrateApp(app);
      if (
        app.name !== `Openship ${host.id}` ||
        app.domain !== host.hostname ||
        app.type !== "self_hosted" ||
        app.destinations?.some((d) => d.uri !== host.hostname || d.overrides?.length) ||
        app.self_hosted_domains?.some((d) => d !== host.hostname) ||
        policyIds(app).some(
          (id) =>
            id !== ownership.appPolicyId &&
            id !== ownership.appNextPolicyId &&
            id !== host.accessPolicyId,
        )
      )
        conflict(
          `The Access application for ${host.hostname} changed outside Openship. It has been retained for review.`,
        );
      const appId = app.id;
      await this.ignoreMissing(() => this.get(`/access/apps/${appId}`, { method: "DELETE" }));
    }
    delete ownership.appId;
    delete ownership.appAud;
    delete ownership.appIntent;
    delete ownership.appPolicyId;
    delete ownership.appNextPolicyId;
    delete ownership.teamName;
    await save(ownership, "ready");
  }
  async deleteTunnel(id: string, name: string): Promise<void> {
    let tunnel: Tunnel;
    try {
      tunnel = await this.tunnel(id);
    } catch (error) {
      if (error instanceof CloudflareApiError && error.providerStatus === 404) return;
      throw error;
    }
    if (tunnel.name !== name)
      conflict("This tunnel was renamed outside Openship. It has been retained for review.");
    let config: TunnelConfig | null;
    try {
      config = await this.configuration(id);
    } catch (error) {
      if (error instanceof CloudflareApiError && error.providerStatus === 404) config = null;
      else throw error;
    }
    if (config?.ingress.some((r) => r.hostname || r.path || r.service !== "http_status:404"))
      conflict(
        "The tunnel still contains routes created outside Openship. Remove those routes before disconnecting.",
      );
    await this.ignoreMissing(() => this.get(`/cfd_tunnel/${id}`, { method: "DELETE" }));
  }
  private async ignoreMissing(work: () => Promise<unknown>) {
    try {
      await work();
    } catch (error) {
      if (!(error instanceof CloudflareApiError && error.providerStatus === 404)) throw error;
    }
  }
}
