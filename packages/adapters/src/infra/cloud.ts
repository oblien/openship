import type { Oblien, DomainRoute, RoutesInput } from "oblien";
import { posix } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AppError, SYSTEM } from "@repo/core";
import type { ManualCert, RouteConfig, SslResult, CommandExecutor, ProvisionLock } from "../types";
import type { RoutingProvider, SslProvider, ProvisionCertOptions } from "./types";
import type { CloudAdminProxy } from "./cloud-admin";
import { cloudPageHostnames } from "../runtime/cloud/page-hostnames";
import { sq } from "../runtime/git-clone";
import { compileResolvedRoutingToOblien } from "../runtime/oblien-routing";
import { probeStaticOutput, type StaticProbeOptions } from "../system/output-exists";
import { CLOUD_DOCKER_BRIDGE_PORT } from "../runtime/cloud/docker-bridge-source";

/** Older Page GET responses use flat fields; connect/renew and newer GETs use
 * the SDK's nested shape. Both must retain an explicit hostname binding. */
interface PageDomainInfo {
  domain?: string;
  customDomain?: string;
  ssl?: { status?: string | null; expiresAt?: string | null } | null;
  sslStatus?: string | null;
  sslExpiry?: string | null;
}

const normalizeHostname = (hostname: string) => hostname.trim().toLowerCase();
const notFound = (error: unknown) => (error as { status?: number })?.status === 404;
const disconnected = () =>
  new AppError(
    "This domain has no Cloud route for this project. Retry routing from Domains & Routes, then verify HTTPS.",
    409,
    "CLOUD_DOMAIN_NOT_CONNECTED",
  );

function checkDomainBinding(bound: string | null | undefined, domain: string): void {
  if (typeof bound !== "string" || normalizeHostname(bound) !== normalizeHostname(domain)) {
    throw new AppError(
      "The Cloud domain binding changed. Refresh Domains & Routes and retry.",
      409,
      "CLOUD_DOMAIN_CHANGED",
    );
  }
}

export interface CloudProjectRoutingScope {
  workspaceId: string;
  projectId: string;
  routeRoot: string;
  /** Bare static releases may be exported only from this project-owned tree. */
  staticReleaseRoot?: string;
  executor: CommandExecutor;
  lock: ProvisionLock;
  publicDomain?: string;
  resolveTarget(containerId: string, port: number): Promise<number>;
  resolveUrl(targetUrl: string): Promise<number>;
}

export interface CloudInfraOptions {
  namespace?: string;
  adminProxy?: CloudAdminProxy;
  scope?: CloudProjectRoutingScope;
  /** Route cleanup is valid while the server is stopped and needs no runtime connection. */
  workspaceId?: string;
  routeRoot?: string;
  /** Cleanup shares the server mutation lock without opening its runtime. */
  lock?: ProvisionLock;
}

/** Routing and certificates are provider-owned; no host proxy or certbot here. */
export class CloudInfraProvider implements RoutingProvider, SslProvider {
  readonly certificateManagement = "provider" as const;
  constructor(
    private readonly client: Oblien,
    private readonly options: CloudInfraOptions = {},
  ) {}

  private get workspaceId() {
    return this.options.scope?.workspaceId ?? this.options.workspaceId;
  }
  private get routeRoot() {
    return this.options.scope?.routeRoot ?? this.options.routeRoot;
  }
  private get lock() {
    const lock = this.options.scope?.lock ?? this.options.lock;
    if (!lock) throw new Error("Managed route mutations require the owning server lock");
    return lock;
  }
  private get scope() {
    if (!this.options.scope || !this.options.namespace)
      throw new Error("Select a managed server and project before changing routes");
    return this.options.scope;
  }
  private get publicDomain() {
    return this.options.scope?.publicDomain ?? SYSTEM.DOMAINS.CLOUD_DOMAIN;
  }

  async getQuota(): Promise<unknown> {
    return this.client.workspaces.getQuota();
  }

  // ── Domain / Slug checks ───────────────────────────────────────────────

  /**
   * Check whether a subdomain slug is available on opsh.io.
   * Uses Oblien's standalone `domain.checkSlug()` - no workspace needed.
   */
  async checkSlug(
    slug: string,
    domain: string = SYSTEM.DOMAINS.CLOUD_DOMAIN,
  ): Promise<{ available: boolean; url: string }> {
    const result = await this.client.domain.checkSlug({ slug, domain });
    return { available: result.available, url: result.url };
  }

  /**
   * Verify DNS records for a custom domain.
   * Uses Oblien's standalone `domain.verify()` - no workspace needed.
   */
  async verifyDomain(
    domain: string,
    resourceId?: string,
  ): Promise<{
    verified: boolean;
    cname: boolean;
    ownership: boolean | null;
    errors: string[];
    requiredRecords: {
      cname: { host: string; target: string };
      txt?: { host: string; value: string };
    };
  }> {
    const result = await this.client.domain.verify({ domain, resource_id: resourceId });
    return {
      verified: result.verified,
      cname: result.cname,
      ownership: result.ownership,
      errors: result.errors,
      requiredRecords: {
        cname: result.required_records.cname,
        txt: result.required_records.txt,
      },
    };
  }

  private get pages() {
    return this.options.adminProxy?.pages ?? this.client.pages;
  }

  private async pageForDomain(domain: string) {
    if (!this.options.namespace)
      throw new Error("Cloud infrastructure requires an organization-scoped platform");
    const normalized = normalizeHostname(domain);
    const matches = (await this.pages.list()).pages.filter(
      (page) =>
        page.namespace === this.options.namespace && cloudPageHostnames(page).includes(normalized),
    );
    if (matches.length > 1) throw new Error("Cloud hostname has ambiguous Page ownership");
    if (!matches[0]) return undefined;
    let page;
    try {
      page = (await this.pages.get(matches[0].slug)).page;
    } catch (error) {
      if ((error as { status?: number }).status === 404) return undefined;
      throw error;
    }
    if (
      page.namespace !== this.options.namespace ||
      !cloudPageHostnames(page).includes(normalized)
    ) {
      throw new Error("Cloud Page ownership changed while applying its route");
    }
    return page;
  }

  private async pageDomain(slug: string, domain: string): Promise<PageDomainInfo> {
    const { domain: info } = (await this.pages.getDomain(slug)) as {
      domain: PageDomainInfo | null;
    };
    checkDomainBinding(info?.customDomain ?? info?.domain, domain);
    return info!;
  }

  private async certificatePage(domain: string) {
    const page = await this.pageForDomain(domain);
    if (
      !page ||
      (this.workspaceId &&
        (page.source_workspace_id !== this.workspaceId ||
          page.exported_path !== `${this.routeRoot}/${page.slug}`))
    )
      throw disconnected();
    return page;
  }

  private async owner(domain: string): Promise<DomainRoute | undefined> {
    if (!this.options.namespace)
      throw new Error("Cloud infrastructure requires an organization-scoped platform");
    const result = this.options.adminProxy?.domainRoutes
      ? await this.options.adminProxy.domainRoutes()
      : await this.client.domain.routes({ namespace: this.options.namespace });
    const matches = result.data.filter(
      (route) =>
        normalizeHostname(route.hostname) === normalizeHostname(domain) &&
        route.namespace === this.options.namespace,
    );
    if (matches.length > 1)
      throw new AppError(
        "Cloud hostname ownership is ambiguous. Retry after the provider state updates.",
        502,
        "CLOUD_DOMAIN_AMBIGUOUS",
      );
    return matches[0];
  }

  async registerRoute(route: RouteConfig): Promise<void> {
    if (route.webhookProxy)
      throw new Error("Managed application routes cannot proxy control-plane webhooks");
    const proxyTargets = new Map<string, { workspace: string; port: number }>();
    for (const location of route.proxyLocations ?? []) {
      if (location.external) continue;
      proxyTargets.set(location.targetUrl, {
        workspace: this.scope.workspaceId,
        port: await this.scope.resolveUrl(location.targetUrl),
      });
    }
    const port = route.targetUrl ? await this.scope.resolveUrl(route.targetUrl) : undefined;
    const custom = !route.domain.endsWith(`.${this.publicDomain}`);
    const slug = this.routeSlug(route.domain, custom);
    const input = compileResolvedRoutingToOblien(
      {
        proxyLocations: route.proxyLocations ?? [],
        redirects: route.redirects ?? [],
        headerRules: route.headerRules ?? [],
        cleanUrls: route.cleanUrls ?? false,
        trailingSlash: route.trailingSlash,
      },
      {
        root: port ? { workspace: this.scope.workspaceId, port } : undefined,
        staticPage: route.staticRoot ? slug : undefined,
        proxyTargets,
      },
    );
    if (route.redirectHost) {
      if (
        !/^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/i.test(route.redirectHost.target) ||
        ![301, 302, 307, 308].includes(route.redirectHost.statusCode)
      )
        throw new Error("Invalid canonical redirect");
      input.routes = [
        {
          match: { path: "/(.*)", type: "wildcard" },
          action: {
            kind: "redirect",
            status: route.redirectHost.statusCode as 301 | 302 | 307 | 308,
            to: `https://${route.redirectHost.target}/$1`,
          },
        },
      ];
    }
    await this.scope.lock.run(() =>
      this.publishRouteUnlocked(route.domain, port, custom, input, route.staticRoot),
    );
  }

  async probeStaticRoot(path: string, options?: StaticProbeOptions) {
    return probeStaticOutput(this.scope.executor, path, {
      ...options,
      edgeOrigin: options?.hostname ? `https://${options.hostname}` : undefined,
    });
  }

  /** Read provider ownership without opening Docker or resuming a stopped VM.
   * Includes route anchors from a deployment that failed before its DB write. */
  async listProjectRouteHostnames(): Promise<string[]> {
    const hostnames: string[] = [];
    for (const summary of (await this.pages.list()).pages) {
      if (summary.namespace !== this.options.namespace) continue;
      let page;
      try {
        page = (await this.pages.get(summary.slug)).page;
      } catch (error) {
        if (notFound(error)) continue;
        throw error;
      }
      if (
        page.namespace === this.options.namespace &&
        page.source_workspace_id === this.workspaceId &&
        page.exported_path === `${this.routeRoot}/${page.slug}`
      )
        hostnames.push(...cloudPageHostnames(page));
    }
    return [...new Set(hostnames)];
  }

  /** A stable Page owns each public hostname; its edge rule proxies to the
   * shared workspace. This supports several custom domains without repeatedly
   * overwriting the workspace API's single custom-domain binding. */
  async publishRoute(
    hostname: string,
    hostPort: number,
    custom: boolean,
    input?: RoutesInput,
  ): Promise<void> {
    return this.scope.lock.run(() => this.publishRouteUnlocked(hostname, hostPort, custom, input));
  }

  private routeSlug(hostname: string, custom: boolean): string {
    const suffix = `.${this.publicDomain}`;
    const slug = custom
      ? `route-${createHash("sha256").update(`${this.scope.projectId}:${hostname}`).digest("hex").slice(0, 32)}`
      : hostname.endsWith(suffix)
        ? hostname.slice(0, -suffix.length)
        : "";
    if (!slug || !/^[a-z0-9-]+$/.test(slug)) throw new Error("Invalid cloud route hostname");
    return slug;
  }

  private async publishRouteUnlocked(
    hostname: string,
    hostPort: number | undefined,
    custom: boolean,
    input?: RoutesInput,
    staticRoot?: string,
  ): Promise<void> {
    hostname = hostname.trim().toLowerCase();
    if (
      hostPort !== undefined &&
      (!Number.isInteger(hostPort) ||
        hostPort < 1 ||
        hostPort > 65535 ||
        hostPort === CLOUD_DOCKER_BRIDGE_PORT)
    )
      throw new Error("Invalid cloud routing port");
    if (hostPort === undefined && !staticRoot)
      throw new Error("A route needs a process or a static release");
    const slug = this.routeSlug(hostname, custom);
    const routes = input ?? {
      routes: [
        {
          match: { path: "/", type: "prefix" as const },
          action: { kind: "proxy" as const, workspace: this.scope.workspaceId, port: hostPort! },
        },
      ],
    };
    await this.assertRouteTargets(routes, hostPort, staticRoot ? slug : undefined);
    const path = `${this.routeRoot}/${slug}`;
    let page;
    try {
      page = (await this.pages.get(slug)).page;
    } catch (error) {
      if (!notFound(error)) throw error;
    }
    const assertPage = () => {
      if (
        page!.source_workspace_id !== this.workspaceId ||
        page!.namespace !== this.options.namespace ||
        page!.exported_path !== path
      )
        throw new Error("Cloud hostname is not owned by this project's route");
    };
    if (page) assertPage();
    const hadPage = Boolean(page);
    let staged: { next: string; previous: string } | undefined;
    let published = false;
    try {
      if (staticRoot) {
        const root = this.scope.staticReleaseRoot;
        const source = posix.resolve(staticRoot);
        if (!root || !source.startsWith(`${root}/`))
          throw new Error("Static source is outside this project's releases");
        const real = (await this.scope.executor.exec(`readlink -f -- ${sq(source)}`)).trim();
        if (!real.startsWith(`${root}/`))
          throw new Error("Static source points outside this project's releases");
        // The export must not follow a symlink into server state or a sibling project.
        const link = (
          await this.scope.executor.exec(`find ${sq(real)} -type l -print -quit`)
        ).trim();
        if (link) throw new Error("Static exports must contain regular files, not symbolic links");
        const next = `${path}.stage-${randomUUID()}`;
        staged = { next, previous: `${next}.previous` };
        // Retain the previous export through domain, ingress and route-table
        // publication too. An acknowledgement from Pages alone is not enough.
        await this.scope.executor.exec(
          `set -eu\nmkdir -p ${sq(next)}\ncp -a ${sq(real)}/. ${sq(next)}/\nif [ -e ${sq(path)} ]; then mv ${sq(path)} ${sq(staged.previous)}; fi\nif ! mv ${sq(next)} ${sq(path)}; then if [ -e ${sq(staged.previous)} ]; then mv ${sq(staged.previous)} ${sq(path)}; fi; exit 1; fi`,
        );
        if (page) {
          const deployed = await this.pages.deploy(slug, {
            workspace_id: this.scope.workspaceId,
            path,
          });
          if (!deployed.success) throw new Error("Could not publish the static release");
        }
      } else if (!page) {
        await this.scope.executor.writeFile(
          `${path}/index.html`,
          "<!doctype html><title>Application starting</title>",
        );
      }
      if (!page) {
        try {
          await this.pages.create({
            workspace_id: this.scope.workspaceId,
            path,
            name: `Route ${hostname}`,
            slug,
            domain: this.publicDomain,
          });
        } catch (error) {
          if ((error as { status?: number }).status !== 409) throw error;
        }
        page = (await this.pages.get(slug)).page;
        assertPage();
      }
      if (custom) {
        if (page.custom_domain && page.custom_domain !== hostname)
          throw new Error("Cloud route is already bound to a different hostname");
        if (page.custom_domain !== hostname)
          await this.pages.connectDomain(slug, { domain: hostname });
      }
      const ports = routes.routes.flatMap((rule) =>
        rule.action.kind === "proxy" &&
        rule.action.workspace === this.workspaceId &&
        rule.action.port
          ? [rule.action.port]
          : [],
      );
      await this.ensureIngressPorts(ports);
      if (!(await this.pages.enable(slug)).success)
        throw new Error("Could not enable the managed route");
      await this.writeRoutes(hostname, routes);
      published = true;
    } catch (error) {
      if (staged) {
        try {
          const restored = await this.scope.executor.exec(
            `set -eu\nif [ -e ${sq(staged.previous)} ]; then rm -rf -- ${sq(path)}; mv ${sq(staged.previous)} ${sq(path)}; printf restored; fi`,
          );
          // Pages stores an exported copy. Restoring the host directory alone
          // would leave a failed release live at the edge.
          if (hadPage && restored.trim() === "restored") {
            if (
              !(await this.pages.deploy(slug, { workspace_id: this.scope.workspaceId, path }))
                .success
            )
              throw new Error("Could not republish the previous static release");
          }
        } catch (restoreError) {
          throw new AggregateError(
            [error, restoreError],
            "Static publication failed and its previous export could not be restored",
            { cause: error },
          );
        }
      }
      throw error;
    } finally {
      if (staged)
        await this.scope.executor
          .exec(`rm -rf -- ${sq(staged.next)}${published ? ` ${sq(staged.previous)}` : ""}`)
          .catch(() => {});
    }
  }

  async resolveRoutingTarget(
    containerId: string,
    port: number,
  ): Promise<{ workspace: string; port: number }> {
    return {
      workspace: this.scope.workspaceId,
      port: await this.scope.resolveTarget(containerId, port),
    };
  }

  private async writeRoutes(hostname: string, input: RoutesInput) {
    if (!this.options.namespace) throw new Error("Cloud routing requires an organization scope");
    const result = this.options.adminProxy?.setRoutes
      ? this.options.adminProxy.setRoutes(hostname, input)
      : this.client.routes.set(hostname, input);
    const applied = await result;
    if (!applied.success) throw new Error("Could not apply the managed route table");
    return applied;
  }

  async setDomainRoutes(hostname: string, input: RoutesInput) {
    return this.scope.lock.run(async () => {
      if (!(await this.listProjectRouteHostnames()).includes(hostname.trim().toLowerCase()))
        throw new AppError("Domain does not belong to this project", 404, "DOMAIN_NOT_FOUND");
      await this.assertRouteTargets(input);
      await this.ensureIngressPorts(
        input.routes.flatMap((route) =>
          route.action.kind === "proxy" &&
          route.action.workspace === this.workspaceId &&
          route.action.port
            ? [route.action.port]
            : [],
        ),
      );
      return this.writeRoutes(hostname, input);
    });
  }

  private async assertRouteTargets(
    input: RoutesInput,
    publishedPort?: number,
    staticPage?: string,
  ) {
    if (input.static?.page && input.static.page !== staticPage) {
      const { page } = await this.pages.get(input.static.page);
      if (
        page.namespace !== this.options.namespace ||
        page.source_workspace_id !== this.workspaceId ||
        page.exported_path !== `${this.routeRoot}/${page.slug}`
      )
        throw new AppError(
          "Static route does not belong to this project",
          409,
          "CLOUD_ROUTE_TARGET_INVALID",
        );
    }
    const ports = new Set<number>();
    if (publishedPort !== undefined) ports.add(publishedPort);
    for (const route of input.routes) {
      if (
        route.action.kind === "proxy" &&
        !route.action.origin &&
        (route.action.workspace !== this.workspaceId ||
          typeof route.action.port !== "number")
      )
        throw new AppError(
          "Routing target does not belong to this project",
          409,
          "CLOUD_ROUTE_TARGET_INVALID",
        );
      if (route.action.kind === "proxy" && !route.action.origin) ports.add(route.action.port!);
    }
    for (const port of ports) {
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new AppError("Invalid routing port", 409, "CLOUD_ROUTE_TARGET_INVALID");
      await this.scope.resolveUrl(`http://127.0.0.1:${port}`);
    }
  }

  /** Keep provider-configured and neighboring listeners intact. This operation
   * only ensures the project's validated route ports can receive edge traffic. */
  private async ensureIngressPorts(add: number[]) {
    if (!add.length) return;
    const workspace = this.client.workspace(this.scope.workspaceId);
    const network = await workspace.network.get();
    const current = Array.isArray(network.ingress_ports) ? (network.ingress_ports as number[]) : [];
    const next = [...new Set([...current, ...add])];
    if (next.length !== current.length || next.some((port) => !current.includes(port))) {
      const result = await workspace.network.update({ ingress_ports: next });
      if (!result.success) throw new Error("Could not update the managed server's ingress ports");
    }
  }

  async removeRoute(domain: string, opts?: { signal?: AbortSignal }): Promise<void> {
    opts?.signal?.throwIfAborted();
    if (!this.workspaceId)
      throw new Error("Route removal requires the owning managed server and project");
    return this.lock.run(async () => {
      // Disabled Pages have no route-registry entry but still own exported
      // files. Inventory by Page hostname also makes their cleanup retryable.
      const page = await this.pageForDomain(domain);
      if (!page) return;
      if (
        page.source_workspace_id !== this.workspaceId ||
        page.exported_path !== `${this.routeRoot}/${page.slug}`
      ) {
        throw new Error("Cloud route is not owned by this project");
      }
      if (page.custom_domain && normalizeHostname(page.custom_domain) === normalizeHostname(domain))
        await this.pageDomain(page.slug, domain);
      opts?.signal?.throwIfAborted();
      if (!(await this.pages.delete(page.slug)).success)
        throw new Error("Could not remove the managed route");
    });
  }

  async suspendRoute(domain: string): Promise<void> {
    return this.lock.run(async () => {
      const page = await this.certificatePage(domain);
      const result = await this.pages.disable(page.slug);
      if (!result.success) throw new Error("Could not pause the site's managed route");
    });
  }

  private certificate(
    domain: string,
    status: string | null | undefined,
    expiry: string | null | undefined,
  ): SslResult {
    const time = expiry ? Date.parse(expiry) : NaN;
    const verified =
      ["active", "valid", "issued", "ready"].includes(status ?? "") &&
      Number.isFinite(time) &&
      time > Date.now();
    return {
      domain,
      expiresAt: Number.isFinite(time) ? new Date(time).toISOString() : "",
      issuer: "oblien",
      verified,
      reason: verified ? "issued" : expiry ? "invalid" : "missing",
    };
  }

  async verifyCert(domain: string): Promise<SslResult> {
    const owner = await this.owner(domain);
    if (!owner) throw disconnected();
    if (!owner.is_custom)
      return { domain, expiresAt: "", issuer: "oblien", verified: false, reason: "not_local" };
    if (owner.owner_type === "page") {
      const page = await this.certificatePage(domain);
      const info = await this.pageDomain(page.slug, domain);
      return this.certificate(
        domain,
        info.ssl?.status ?? info.sslStatus,
        info.ssl?.expiresAt ?? info.sslExpiry,
      );
    }
    throw new Error("Certificate is not owned by this project's route");
  }

  async provisionCert(domain: string, opts?: ProvisionCertOptions): Promise<SslResult> {
    const current = await this.verifyCert(domain);
    if ((current.verified && !opts?.force) || current.reason === "not_local") return current;
    return this.renewCert(domain);
  }

  async renewCert(domain: string): Promise<SslResult> {
    const owner = await this.owner(domain);
    if (!owner) throw disconnected();
    if (!owner.is_custom) return this.verifyCert(domain);
    if (owner.owner_type === "page") {
      const page = await this.certificatePage(domain);
      await this.pageDomain(page.slug, domain);
      await this.pages.renewSSL(page.slug);
    } else throw new Error("Certificate is not owned by this project's route");
    const result = await this.verifyCert(domain);
    return result.verified ? { ...result, reason: "renewed" } : result;
  }

  async installCert(_domain: string, _cert: ManualCert): Promise<SslResult> {
    throw new Error("Manual certificates are not supported on Openship Cloud");
  }
}
