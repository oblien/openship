import type { CloudAdminProxy } from "@repo/adapters";
import { AppError } from "@repo/core";
import { getOblienClient } from "./oblien-client";
import { assertCloudCanSpend } from "../modules/billing/billing-oblien-quota";

/**
 * Pages and hostname route tables currently require Oblien admin scope. Keep
 * that credential here, behind authoritative namespace checks on EVERY resource.
 * The caller obtains namespace from its authenticated org, never from a body.
 */
export function createTenantCloudAdmin(organizationId: string, namespace: string): CloudAdminProxy {
  const admin = getOblienClient();
  const deny = () => new AppError("Cloud resource not found in this organization", 404, "CLOUD_RESOURCE_NOT_FOUND");
  const validateId = (value: string) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw deny();
  };
  const requireWorkspace = async (id: string) => {
    validateId(id);
    const workspace = await admin.workspaces.get(id);
    if (workspace.namespace !== namespace) throw deny();
    return workspace;
  };
  const requirePage = async (slug: string) => {
    validateId(slug);
    const result = await admin.pages.get(slug);
    if (result.page.namespace !== namespace) throw deny();
    return result;
  };
  const domainRoutes = async () => {
    const result = await admin.domain.routes({ namespace });
    return { ...result, data: result.data.filter((route) => route.namespace === namespace) };
  };
  const pages: NonNullable<CloudAdminProxy["pages"]> = {
    list: async () => {
      const result = await admin.pages.list();
      const owned = [];
      for (const summary of result.pages) {
        if (summary.namespace != null && summary.namespace !== namespace) continue;
        // Some provider endpoints return summaries. Resolve omitted namespace
        // fields server-side before returning any metadata to the customer.
        const page = summary.namespace == null ? (await admin.pages.get(summary.slug)).page : summary;
        if (page.namespace === namespace) owned.push(page);
      }
      return { ...result, pages: owned };
    },
    get: requirePage,
    create: async (input) => {
      if (input.slug) validateId(input.slug);
      await requireWorkspace(input.workspace_id);
      await assertCloudCanSpend(organizationId);
      return admin.pages.create({ ...input, namespace });
    },
    deploy: async (slug, input) => {
      await requirePage(slug);
      await requireWorkspace(input.workspace_id);
      await assertCloudCanSpend(organizationId);
      return admin.pages.deploy(slug, input);
    },
    delete: async (slug) => { await requirePage(slug); return admin.pages.delete(slug); },
    disable: async (slug) => { await requirePage(slug); return admin.pages.disable(slug); },
    enable: async (slug) => {
      await requirePage(slug);
      await assertCloudCanSpend(organizationId);
      return admin.pages.enable(slug);
    },
    getDomain: async (slug) => { await requirePage(slug); return admin.pages.getDomain(slug); },
    connectDomain: async (slug, input) => { await requirePage(slug); return admin.pages.connectDomain(slug, input); },
    disconnectDomain: async (slug) => { await requirePage(slug); return admin.pages.disconnectDomain(slug); },
    checkDNS: async (slug, input) => { await requirePage(slug); return admin.pages.checkDNS(slug, input); },
    renewSSL: async (slug) => { await requirePage(slug); return admin.pages.renewSSL(slug); },
  };
  return {
    pages,
    createPage: (input) => pages.create(input),
    disablePage: async (slug) => { await pages.disable(slug); },
    enablePage: async (slug) => { await pages.enable(slug); },
    deletePage: async (slug) => { await pages.delete(slug); },
    domainRoutes,
    domainSsls: async () => {
      const result = await admin.domain.ssls({ namespace });
      return { ...result, data: result.data.filter((cert) => cert.namespace === namespace) };
    },
    setRoutes: async (hostname, input) => {
      const normalized = hostname.trim().toLowerCase();
      const owned = (await domainRoutes()).data.some((route) => route.hostname.toLowerCase() === normalized);
      if (!owned) throw deny();
      if (input.static) await requirePage(input.static.page);
      const workspaces = new Set<string>();
      for (const rule of input.routes) {
        if (rule.action.kind !== "proxy") continue;
        // External origins need separate tenant ownership verification. Admin
        // scope alone would authorize another customer's verified origin.
        if (rule.action.origin || !rule.action.workspace) {
          throw new AppError("Cloud routes must target a workspace in this organization", 400, "CLOUD_ROUTE_TARGET_INVALID");
        }
        workspaces.add(rule.action.workspace);
      }
      await Promise.all([...workspaces].map(requireWorkspace));
      return admin.routes.set(normalized, input);
    },
  };
}
