import type { Oblien, DomainRoute } from "oblien";
import type { ManualCert, RouteConfig, SslResult } from "../types";
import type { RoutingProvider, SslProvider, ProvisionCertOptions } from "./types";
import type { CloudAdminProxy } from "../runtime/cloud";
import { cloudPageHostnames } from "../runtime/cloud/page-hostnames";

/** Routing and certificates are provider-owned; no host proxy or certbot here. */
export class CloudInfraProvider implements RoutingProvider, SslProvider {
  constructor(private readonly client: Oblien, private readonly options: {
    namespace?: string; adminProxy?: CloudAdminProxy; dockerWorkspaceId?: string;
  } = {}) {}

  private get pages() { return this.options.adminProxy?.pages ?? this.client.pages; }

  private async pageForDomain(domain: string) {
    if (!this.options.namespace) throw new Error("Cloud infrastructure requires an organization-scoped platform");
    const normalized = domain.toLowerCase();
    const matches = (await this.pages.list()).pages.filter(page =>
      page.namespace === this.options.namespace && cloudPageHostnames(page).includes(normalized));
    if (matches.length > 1) throw new Error("Cloud hostname has ambiguous Page ownership");
    if (!matches[0]) return undefined;
    let page;
    try { page = (await this.pages.get(matches[0].slug)).page; }
    catch (error) { if ((error as { status?: number }).status === 404) return undefined; throw error; }
    if (page.namespace !== this.options.namespace || !cloudPageHostnames(page).includes(normalized)) {
      throw new Error("Cloud Page ownership changed while applying its route");
    }
    return page;
  }

  private async owner(domain: string): Promise<DomainRoute | undefined> {
    if (!this.options.namespace) throw new Error("Cloud infrastructure requires an organization-scoped platform");
    const result = this.options.adminProxy?.domainRoutes
      ? await this.options.adminProxy.domainRoutes()
      : await this.client.domain.routes();
    return result.data.find((route) =>
      route.hostname.toLowerCase() === domain.toLowerCase() &&
      route.namespace === this.options.namespace);
  }

  async registerRoute(route: RouteConfig): Promise<void> {
    const owner = await this.owner(route.domain);
    if (!owner) throw new Error("Connect this domain to a cloud workspace or page before applying its routes");
    // Advanced deployment rules go through compileRoutingToOblien. A generic
    // host route cannot silently discard those settings.
    if (route.proxyLocations?.length || route.redirects?.length || route.headerRules?.length ||
        route.redirectHost || route.webhookProxy) {
      throw new Error("Cloud routing rules must be applied through the cloud deployment route table");
    }
    const setRoutes = this.options.adminProxy?.setRoutes ??
      ((hostname, input) => this.client.routes.set(hostname, input));
    if (owner.owner_type === "page" && route.staticRoot) {
      const page = await this.pageForDomain(route.domain);
      if (!page) throw new Error("Cloud route Page is unavailable");
      await setRoutes(route.domain, {
        static: { page: page.slug }, routes: [],
        cleanUrls: route.cleanUrls,
        trailingSlash: route.trailingSlash === undefined ? undefined : route.trailingSlash ? "enforce" : "strip",
      });
      return;
    }
    if (owner.owner_type !== "workspace" || !route.targetUrl) {
      throw new Error("Cloud route target does not match its owning resource");
    }
    const target = new URL(route.targetUrl);
    const current = new URL(owner.target.includes("://") ? owner.target : `http://${owner.target}`);
    if (target.hostname !== current.hostname || target.username || target.password) {
      throw new Error("Cloud route target must belong to its owning workspace");
    }
    const port = Number(target.port || (target.protocol === "https:" ? 443 : 80));
    await setRoutes(route.domain, { routes: [{ match: { path: "/", type: "prefix" },
      action: { kind: "proxy", workspace: owner.owner_id, port } }] });
  }

  async removeRoute(domain: string, opts?: { signal?: AbortSignal }): Promise<void> {
    opts?.signal?.throwIfAborted();
    if (this.options.dockerWorkspaceId) {
      // Disabled Pages have no route-registry entry but still own exported
      // files. Inventory by Page hostname also makes their cleanup retryable.
      const page = await this.pageForDomain(domain);
      if (!page) return;
      if (page.source_workspace_id !== this.options.dockerWorkspaceId ||
          page.exported_path !== `/opt/openship/cloud-docker/routes/${page.slug}`) {
        throw new Error("Cloud route is not owned by this Docker project");
      }
      opts?.signal?.throwIfAborted();
      await this.pages.delete(page.slug);
      return;
    }
    const owner = await this.owner(domain);
    if (!owner) return; // authoritative absent route: idempotent retry
    opts?.signal?.throwIfAborted();
    if (owner.owner_type === "page") {
      const page = await this.pageForDomain(domain);
      if (!page) throw new Error("Cloud route Page is unavailable");
      if (owner.is_custom) {
        const current = await this.pages.getDomain(page.slug);
        if (current.domain?.domain.toLowerCase() !== domain.toLowerCase()) {
          throw new Error("Cloud domain changed while removing its route; retry the operation");
        }
        await this.pages.disconnectDomain(page.slug);
      }
      else await this.pages.disable(page.slug);
      return;
    }
    if (owner.owner_type !== "workspace") throw new Error("Cloud route is owned by an unsupported resource type");
    const ws = this.client.workspace(owner.owner_id);
    if (owner.is_custom) {
      const current = await ws.domains.get();
      if (current?.customDomain.toLowerCase() !== domain.toLowerCase()) {
        throw new Error("Cloud domain changed while removing its route; retry the operation");
      }
      await ws.domains.disconnect();
    } else {
      const ports = await ws.publicAccess.list();
      let removed = false;
      for (const exposed of ports) {
        const hostnames = [exposed.url ? new URL(exposed.url).hostname : "", exposed.domain ?? "",
          typeof exposed.slug === "string" && exposed.domain ? `${exposed.slug}.${exposed.domain}` : ""];
        if (hostnames.some((hostname) => hostname.toLowerCase() === domain.toLowerCase())) {
          opts?.signal?.throwIfAborted();
          await ws.publicAccess.revoke(exposed.port);
          removed = true;
        }
      }
      if (!removed) throw new Error("Cloud route has no matching exposed port; retry after the provider state updates");
    }
  }

  private certificate(domain: string, status: string | null | undefined, expiry: string | null | undefined): SslResult {
    const time = expiry ? Date.parse(expiry) : NaN;
    const verified = ["active", "valid", "issued", "ready"].includes(status ?? "") && Number.isFinite(time) && time > Date.now();
    return {
      domain, expiresAt: Number.isFinite(time) ? new Date(time).toISOString() : "",
      issuer: "oblien", verified, reason: verified ? "issued" : expiry ? "invalid" : "missing",
    };
  }

  async verifyCert(domain: string): Promise<SslResult> {
    const owner = await this.owner(domain);
    if (!owner) throw new Error("Domain is not connected to this organization's cloud resources");
    if (!owner.is_custom) return { domain, expiresAt: "", issuer: "oblien", verified: false, reason: "not_local" };
    if (owner.owner_type === "page") {
      const page = await this.pageForDomain(domain);
      if (!page) throw new Error("Cloud route Page is unavailable");
      const { domain: info } = await this.pages.getDomain(page.slug);
      return this.certificate(domain, info?.ssl.status, info?.ssl.expiresAt);
    }
    if (owner.owner_type !== "workspace") throw new Error("Certificate is owned by an unsupported cloud resource");
    const info = await this.client.workspace(owner.owner_id).domains.get();
    return this.certificate(domain, info?.sslStatus, info?.sslExpiry);
  }

  async provisionCert(domain: string, opts?: ProvisionCertOptions): Promise<SslResult> {
    const current = await this.verifyCert(domain);
    if ((current.verified && !opts?.force) || current.reason === "not_local") return current;
    return this.renewCert(domain);
  }

  async renewCert(domain: string): Promise<SslResult> {
    const owner = await this.owner(domain);
    if (!owner) throw new Error("Domain is not connected to this organization's cloud resources");
    if (!owner.is_custom) return this.verifyCert(domain);
    if (owner.owner_type === "page") {
      const page = await this.pageForDomain(domain);
      if (!page) throw new Error("Cloud route Page is unavailable");
      await this.pages.renewSSL(page.slug);
    }
    else if (owner.owner_type === "workspace") await this.client.workspace(owner.owner_id).domains.renewSSL();
    else throw new Error("Certificate is owned by an unsupported cloud resource");
    const result = await this.verifyCert(domain);
    return result.verified ? { ...result, reason: "renewed" } : result;
  }

  async installCert(_domain: string, _cert: ManualCert): Promise<SslResult> {
    throw new Error("Manual certificates are not supported on Openship Cloud");
  }
}
