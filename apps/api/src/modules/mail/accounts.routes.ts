import { Hono, type Handler } from "hono";
import { MailRequestSchemas } from "@repo/contracts";
import { resolveMailAccountTarget } from "./account-target";
import { managedAccount } from "../managed-mail/account.controller";
import { mailRoutePath, mailAccountStatus } from "./account-path";
import type { PermissionSpec } from "../../lib/route-permission";
import { secureRouter } from "../../lib/secure-router";

const r = secureRouter(new Hono(), {
  module: "mail",
  basePath: "/api/mail",
  ids: { mail_server: "serverId" },
});
r.post("/admin/:serverId/tenant-access", {
  tag: "mail_server:admin", localOnly: true, mcpExcluded: "Operator enrollment for shared mail.",
}, async c => (await import("./tenant-access")).issueTenantAccess(c));

type AdminController = typeof import("./admin/admin.controller");
function account(
  method: "get" | "post" | "patch" | "delete",
  path: string,
  spec: PermissionSpec,
  name: keyof AdminController,
) {
  const local: Handler = async (c, next) => {
    const controller = await import("./admin/admin.controller");
    return (controller[name] as Handler)(c, next);
  };
  r[method](path, spec, async (c, next) => {
    const target = await resolveMailAccountTarget(
      c,
      method === "get" ? "read" : method === "delete" ? "admin" : "write",
    );
    if (target.kind === "instance") return local(c, next);
    if (target.kind === "linked") {
      const pathOnCloud = mailRoutePath(path, c.req.param());
      const body = method === "post" || method === "patch" ? await c.req.text() : undefined;
      const result = await target.request(pathOnCloud + new URL(c.req.url).search, {
        method: c.req.method,
        headers: { "content-type": "application/json" },
        body,
      });
      return c.json(result, mailAccountStatus(c.req.method, path));
    }
    return managedAccount(c, path, target.engine);
  });
  // DNS provider writes use the customer's Cloud connection. Only record inspection
  // and acknowledgment are delegated to the shared mail worker.
  if (path.endsWith("/dns/plan") || path.endsWith("/dns/apply")) return;
  const { mcp: _mcp, ...workerSpec } = spec;
  r[method](
    "/tenants/:mailTenant" + path,
    {
      ...workerSpec,
      localOnly: true,
      mcpExcluded: "Internal tenant-scoped mail worker operation.",
    },
    async (c, next) => {
      const { authorizeTenantAccount } = await import("./tenant-access");
      await authorizeTenantAccount(c, path);
      return local(c, next);
    },
  );
}

account(
  "get",
  "/admin/:serverId/domains",
  {
    tag: "mail_server:list",
    mcp: { description: "List mail domains configured on this mail server." },
  },
  "listDomainsHandler",
);
account(
  "post",
  "/admin/:serverId/domains",
  {
    tag: "mail_server:write",
    mcp: {
      description:
        "Create a mail domain with mailbox, alias and quota limits. Then inspect its DNS plan and apply or configure the required records.",
    },
    body: MailRequestSchemas.createDomain,
  },
  "createDomainHandler",
);
account(
  "get",
  "/admin/:serverId/domains/:domain",
  {
    tag: "mail_server:read",
    mcp: { description: "Read a mail domain’s configuration and status." },
  },
  "getDomainHandler",
);
account(
  "patch",
  "/admin/:serverId/domains/:domain",
  {
    tag: "mail_server:write",
    mcp: {
      description:
        "Update a mail domain’s description, capacity limits, default quota or enabled state.",
    },
    body: MailRequestSchemas.updateDomain,
  },
  "updateDomainHandler",
);
account(
  "delete",
  "/admin/:serverId/domains/:domain",
  {
    tag: "mail_server:admin",
    mcp: {
      description:
        "Delete a mail domain. Inspect dependents first; query.cascade=true also removes dependent mailboxes and aliases.",
    },
    query: MailRequestSchemas.deleteDomain,
  },
  "deleteDomainHandler",
);
account(
  "get",
  "/admin/:serverId/domains/:domain/dependents",
  {
    tag: "mail_server:read",
    mcp: { description: "Inspect mailboxes and aliases affected by deleting this mail domain." },
  },
  "domainDependentsHandler",
);
account(
  "get",
  "/admin/:serverId/domains/:domain/dns",
  {
    tag: "mail_server:read",
    mcp: {
      description:
        "Read required DNS records and the current DNS acknowledgment state for this mail domain.",
    },
  },
  "getDomainDnsHandler",
);
account(
  "post",
  "/admin/:serverId/domains/:domain/dns/acknowledge",
  {
    tag: "mail_server:write",
    mcp: {
      description:
        "Recheck and acknowledge a mail domain’s DNS configuration. Only use after the required records have been configured.",
    },
  },
  "acknowledgeDomainDnsHandler",
);
account(
  "get",
  "/admin/:serverId/domains/:domain/dns/plan",
  {
    tag: "mail_server:read",
    mcp: {
      description:
        "Preview DNS changes for this mail domain through a connected DNS provider. Does not apply records.",
    },
  },
  "planDomainDnsHandler",
);
account(
  "post",
  "/admin/:serverId/domains/:domain/dns/apply",
  {
    tag: "mail_server:write",
    mcp: {
      description:
        "Apply this mail domain’s required DNS records through a connected provider. Inspect the DNS plan first.",
    },
  },
  "applyDomainDnsHandler",
);
account(
  "get",
  "/admin/:serverId/domains-dns/pending",
  {
    tag: "mail_server:read",
    mcp: { description: "List mail domains still requiring DNS configuration or acknowledgment." },
  },
  "pendingDomainDnsHandler",
);
account(
  "get",
  "/admin/:serverId/mailboxes",
  {
    tag: "mail_server:list",
    mcp: {
      description:
        "List mailboxes, optionally filtered by query.domain. Passwords are not returned.",
    },
    query: MailRequestSchemas.domainFilter,
  },
  "listMailboxesHandler",
);
account(
  "post",
  "/admin/:serverId/mailboxes",
  {
    tag: "mail_server:write",
    mcp: {
      description:
        "Create a mailbox with a supplied password and optional quota. This changes the mail server’s account database.",
    },
    body: MailRequestSchemas.createMailbox,
  },
  "createMailboxHandler",
);
account(
  "get",
  "/admin/:serverId/mailboxes/:email",
  {
    tag: "mail_server:read",
    mcp: { description: "Read a mailbox’s profile, quota and enabled state without its password." },
  },
  "getMailboxHandler",
);
account(
  "patch",
  "/admin/:serverId/mailboxes/:email",
  {
    tag: "mail_server:write",
    mcp: {
      description:
        "Update a mailbox’s name, quota, password or enabled state. Omit password to preserve it.",
    },
    body: MailRequestSchemas.updateMailbox,
  },
  "updateMailboxHandler",
);
account(
  "delete",
  "/admin/:serverId/mailboxes/:email",
  {
    tag: "mail_server:admin",
    mcp: {
      description:
        "Remove a mailbox account. query.hard=true also deletes its stored mail; read its details before requesting permanent removal.",
    },
    query: MailRequestSchemas.deleteMailbox,
  },
  "deleteMailboxHandler",
);
account(
  "get",
  "/admin/:serverId/aliases",
  {
    tag: "mail_server:list",
    mcp: { description: "List mail aliases and forwards, optionally filtered by query.domain." },
    query: MailRequestSchemas.domainFilter,
  },
  "listAliasesHandler",
);
account(
  "post",
  "/admin/:serverId/aliases",
  {
    tag: "mail_server:write",
    mcp: {
      description:
        "Create a mail alias, forward or catch-all and its destination. A catch-all applies to unmatched recipients in the domain.",
    },
    body: MailRequestSchemas.createAlias,
  },
  "createAliasHandler",
);
account(
  "patch",
  "/admin/:serverId/aliases/:id",
  {
    tag: "mail_server:write",
    mcp: { description: "Enable or disable this mail alias using body.active." },
    body: MailRequestSchemas.updateAlias,
  },
  "updateAliasHandler",
);
account(
  "delete",
  "/admin/:serverId/aliases/:id",
  {
    tag: "mail_server:admin",
    mcp: {
      description:
        "Delete a mail alias or forward. Messages addressed through it will no longer use that mapping.",
    },
  },
  "deleteAliasHandler",
);
account(
  "get",
  "/admin/:serverId/stats",
  {
    tag: "mail_server:read",
    mcp: { description: "Read mail-server domain, mailbox, alias and storage totals." },
  },
  "getStatsHandler",
);
account(
  "get",
  "/admin/:serverId/dns-scan",
  {
    tag: "mail_server:read",
    mcp: {
      description:
        "Check current mail DNS records, optionally for query.domain. Does not apply changes.",
    },
    query: MailRequestSchemas.domainFilter,
  },
  "getDnsScanHandler",
);

export const mailAccountRoutes = r.hono;
