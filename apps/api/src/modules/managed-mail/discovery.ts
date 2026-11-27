import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";
import { AppError } from "@repo/core";
import { managedMailDomainProof } from "@repo/contracts";
import { hostedMailboxOrigin } from "@repo/platform/engine/modules/managed-mail/service";

async function records<T>(query: Promise<T[]>): Promise<T[]> {
  try {
    return await query;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return [];
    throw new AppError("Mailbox discovery is temporarily unavailable. Try again.", 503);
  }
}

export async function discoverMailbox(input?: string) {
  const domain = input?.trim().toLowerCase();
  if (!domain || !domain.includes(".") || isIP(domain) || !z.hostname().safeParse(domain).success)
    throw new AppError("Enter a mailbox domain.", 400);

  // Pick up the current network's nameservers when a long-running API changes networks.
  const dns = new Resolver({ timeout: 1500, tries: 2 });
  const proof = managedMailDomainProof("", domain);
  const txt = await records(dns.resolveTxt(proof.name));
  const ids = new Set(
    txt
      .map((chunks) => chunks.join(""))
      .filter((value) => value.startsWith(proof.value))
      .map((value) => value.slice(proof.value.length))
      .filter((id) => /^managed-mail-[a-f0-9-]{32,36}$/.test(id)),
  );
  if (ids.size > 1) return null;
  if (ids.size === 1) {
    const origin = await hostedMailboxOrigin({ id: [...ids][0]! }, domain);
    if (origin) return origin;
  }
  // The ownership TXT may be removed after setup. A primary MX can identify the same host.
  const mx = await records(dns.resolveMx(domain));
  const priority = Math.min(...mx.map((record) => record.priority));
  const hosts = new Set(
    mx
      .filter((record) => record.priority === priority)
      .map((record) => record.exchange.toLowerCase().replace(/\.$/, "")),
  );
  if (hosts.size !== 1) return null;
  const hostname = [...hosts][0]!;
  return hostname ? hostedMailboxOrigin({ hostname }, domain) : null;
}
