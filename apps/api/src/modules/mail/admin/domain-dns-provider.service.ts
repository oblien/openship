/**
 * On-demand DNS auto-configure for mail domains, via a connected DNS provider.
 *
 * The manual-publish path (`domain-dns.service`) is untouched and stays the
 * fallback when no provider owns the zone. This reads the SAME persisted record
 * set the "publish these records" banner shows and, on operator press, writes it
 * through the org's connected provider (Settings→DNS). Nothing is written on add:
 * plan is a read-only preview, apply is the button.
 */

import {
  planRecords,
  provisionRecords,
  type DnsPlanResult,
  type DnsProvisionResult,
} from "../../dns/dns-credential.service";
import type { DnsRecordInput, DnsRecordType } from "../../dns/types";
import type { DnsRecordSet, PersistedDnsRecord } from "../mail-state";
import { acknowledgeDomainDns, getDomainDnsState } from "./domain-dns.service";

/**
 * The persisted mail record set as provider inputs. MX carries its `priority`
 * (Cloudflare rejects an MX create without one); empty-value records are dropped
 * — plan/provision treat "" as nothing to write. `extraRecords` (relay send-hop:
 * SES DKIM CNAMEs + MAIL FROM) are included so auto-configure covers exactly what
 * the banner would have the operator paste.
 */
function recordSetToInputs(set: DnsRecordSet): DnsRecordInput[] {
  const all: Array<PersistedDnsRecord | undefined> = [
    set.mx,
    set.spf,
    set.dkim,
    set.dmarc,
    ...(set.extraRecords ?? []),
  ];
  return all
    .filter((r): r is PersistedDnsRecord => Boolean(r?.value))
    .map((r) => ({
      type: r.type as DnsRecordType,
      name: r.name,
      content: r.value,
      ...(typeof r.priority === "number" ? { priority: r.priority } : {}),
    }));
}

/**
 * The desired inputs for a mail domain, read from its persisted DNS state. An
 * additional domain always has a saved record set (written at add time); a
 * domain with none (e.g. the primary install, whose records live elsewhere)
 * yields nothing to plan/apply here.
 */
async function resolveMailDnsInputs(
  serverId: string,
  domain: string,
): Promise<DnsRecordInput[]> {
  const state = await getDomainDnsState(serverId, domain);
  if (!state) return [];
  return recordSetToInputs(state.records);
}

/** Dry-run: what auto-configuring this mail domain's DNS would do. Reads only. */
export async function planMailDomainDns(
  organizationId: string,
  serverId: string,
  domain: string,
): Promise<DnsPlanResult> {
  const inputs = await resolveMailDnsInputs(serverId, domain);
  return planRecords(organizationId, domain, inputs);
}

/**
 * Write this mail domain's records through the connected provider, on press.
 *
 * On full success the manual "publish these records" banner is cleared — the
 * same acknowledgement the operator would make by hand — so the automated and
 * manual paths converge on one state. A failed ack only re-shows the banner; the
 * records are already live, so it is best-effort and never fails the apply.
 */
export async function applyMailDomainDns(
  organizationId: string,
  serverId: string,
  domain: string,
): Promise<DnsProvisionResult> {
  const inputs = await resolveMailDnsInputs(serverId, domain);
  const result = await provisionRecords(organizationId, domain, inputs);
  if (result.provisioned) {
    await acknowledgeDomainDns(serverId, domain).catch(() => {});
  }
  return result;
}
