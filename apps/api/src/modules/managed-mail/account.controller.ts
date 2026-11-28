import { mailRoutePath, mailAccountStatus, mailRequestDomains, readMailRequestBody } from "../mail/account-path";
import type { Context } from "hono";
import {
  engineRequest,
  type MailTarget,
} from "@repo/platform/engine/modules/managed-mail/engine-client";
import { verifyMailDomainOwnership } from "../mail/domain-proof";
import { AppError, PRICING } from "@repo/core";
import {
  managedMailboxCapacity,
  type MailDomainDnsSchema,
} from "@repo/contracts";
import { createProvisionLock } from "@repo/platform/engine/lib/provision-lock";
import { requireMailEntitlement } from "@repo/platform/engine/modules/managed-mail/service";
import { validateMailDomain } from "@repo/platform/engine/modules/mail/mail-domain";
import { getRequestContext } from "../../lib/request-context";

import type { Static } from "@sinclair/typebox";
type DomainDns = Static<typeof MailDomainDnsSchema>;

function publicDns({ domain, records, acknowledgedAt, createdAt }: DomainDns): DomainDns {
  return { domain, records, acknowledgedAt, createdAt };
}

function notFound(): never {
  throw new AppError("Mail resource not found.", 404, "MAIL_NOT_FOUND");
}
function limit(message: string): never {
  throw new AppError(message, 409, "MAIL_PLAN_LIMIT");
}

export async function managedAccount(c: Context, pattern: string, engine: MailTarget) {
  const ctx = getRequestContext(c);
  const method = c.req.method;
  const serverId = c.req.param("serverId")!;

  const path = mailRoutePath(pattern, { ...c.req.param(), serverId: engine.serverId });
  const root = "/admin/" + encodeURIComponent(engine.serverId);
  const primary = engine.hostname.toLowerCase().replace(/^mail\./, "");
  const query = new URLSearchParams();
  for (const key of ["domain", "hard", "cascade"]) {
    const value = c.req.query(key);
    if (value !== undefined) query.set(key, value);
  }
  const suffix = query.size ? "?" + query : "";
  const body =
    ["POST", "PATCH"].includes(method) && c.req.header("content-type")?.includes("application/json")
      ? await readMailRequestBody(c)
      : undefined;
  const requestedDomains = mailRequestDomains(c, body);
  if (requestedDomains.includes(primary) || new Set(requestedDomains).size > 1) notFound();
  const domain = requestedDomains[0] ?? "";

  async function domains() {
    const { domains } = await engineRequest<{ domains: Array<{ domain: string }> }>(
      engine,
      root + "/domains",
    );
    return domains.filter((item) => item.domain !== primary);
  }
  if (method === "GET" && path === root + "/domains") return c.json({ domains: await domains() });

  if (method === "GET") {
    if (path === root + "/stats")
      return c.json(
        await engineRequest<object>(engine, path + "?excludeDomain=" + encodeURIComponent(primary) + (c.req.query("inbox") === "1" ? "&inbox=1" : "")),
      );
    if (pattern.endsWith("/domains/:domain/dns"))
      return c.json(publicDns(await engineRequest<DomainDns>(engine, path)));
    if (path === root + "/domains-dns/pending") {
      const { pending } = await engineRequest<{ pending: DomainDns[] }>(engine, path);
      return c.json({ pending: pending.filter((row) => row.domain !== primary).map(publicDns) });
    }
    if (!domain && ["/dns-scan", "/mailboxes", "/aliases"].some((s) => path === root + s))
      throw new AppError("Select a customer domain first.", 400);
  }

  const execute = async () => {
    if (pattern.endsWith("/dns/plan") || pattern.endsWith("/dns/apply")) {
      if (method !== "GET") await requireMailEntitlement(ctx.organizationId, serverId);
      const { planMailDomainDns, applyMailDomainDns } =
        await import("../mail/admin/domain-dns-provider.service");
      const dnsPath = root + "/domains/" + encodeURIComponent(domain) + "/dns";
      const action = method === "GET" ? planMailDomainDns : applyMailDomainDns;
      return {
        data: await action(ctx.organizationId, serverId, domain, {
          read: () => engineRequest(engine, dnsPath),
          acknowledge: () => engineRequest(engine, dnsPath + "/acknowledge", "POST"),
        }),
      };
    }
    if (!engine.tenant && pattern.endsWith("/aliases/:id")) {
      const { aliases } = await engineRequest<{ aliases: Array<{ id: number }> }>(
        engine,
        root + "/aliases?domain=" + encodeURIComponent(primary),
      );
      if (aliases.some((alias) => alias.id === Number(c.req.param("id")))) notFound();
    }
    if (path === root + "/domains" && method === "POST") {
      const { plan, allowance } = await requireMailEntitlement(ctx.organizationId, serverId);
      validateMailDomain(domain);
      if ((await domains()).length >= (allowance?.domains ?? PRICING.mail.plans[plan].domains))
        limit("Your plan’s domain allowance is full.");
      await verifyMailDomainOwnership(serverId, domain);
      return engineRequest(engine, path, method, { ...body, domain, createPostmaster: false });
    }
    if (method !== "GET" && method !== "DELETE") {
      const grant = await requireMailEntitlement(ctx.organizationId, serverId);
      if (
        path === root + "/mailboxes" ||
        (pattern.endsWith("/mailboxes/:email") && body?.quotaMB !== undefined)
      ) {
        const limits = managedMailboxCapacity(
          PRICING.mail.plans[grant.plan],
          grant.dedicated,
          engine,
        );
        const all = await domains();
        if (!all.some((item) => item.domain === domain)) notFound();
        const boxes = (
          await Promise.all(
            all.map((item) =>
              engineRequest<{ mailboxes: Array<{ username: string; quotaMB: number }> }>(
                engine,
                root + "/mailboxes?domain=" + encodeURIComponent(item.domain),
              ),
            ),
          )
        ).flatMap((item) => item.mailboxes);
        if (method === "POST" && limits.mailboxes !== null && boxes.length >= limits.mailboxes)
          limit("Your plan’s mailbox allowance is full.");
        const others = boxes.filter((box) => box.username !== c.req.param("email")?.toLowerCase());
        const available =
          limits.storageMB -
          others.reduce((sum, box) => sum + (box.quotaMB || limits.storageMB), 0);
        const defaultQuota =
          limits.mailboxes === null ? 1024 : Math.floor(limits.storageMB / limits.mailboxes);
        const quota = Number(body?.quotaMB) || Math.min(available, defaultQuota);
        if (!Number.isSafeInteger(quota) || quota <= 0 || quota > available)
          limit("The mailbox quota exceeds your plan’s remaining storage.");
        return engineRequest(engine, path, method, { ...body, quotaMB: quota });
      }
      if (domain && !(await domains()).some((item) => item.domain === domain)) notFound();
    }
    return engineRequest(engine, path + suffix, method, body);
  };
  const data =
    method === "GET"
      ? await execute()
      : await createProvisionLock("managed-mail:account:" + serverId).run(execute);
  return c.json(data as object, mailAccountStatus(method, pattern));
}
