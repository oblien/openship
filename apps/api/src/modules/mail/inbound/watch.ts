/**
 * The `mail:inbound-watch` job body — one sweep across every mail server with rules.
 *
 * Kept out of `job.registry.ts` and behind a dynamic import for the same reason the whole
 * mail module is: it must not load into the cloud runtime, where the engine does not exist.
 *
 * Cheap when idle by design. A server with no enabled rules costs one indexed query and
 * ZERO SSH, which matters at a one-minute cadence on an instance where most boxes are not
 * mail servers.
 */

import { safeErrorMessage } from "@repo/core";
import { repos, type MailInboundScope } from "@repo/db";
import { getInstanceSmtpSenders } from "./senders";
import { runInboundForServer } from "./read";
import { reconcileDomains, ruleDomain } from "./capture";

/** Index signature so this satisfies the job runner's `JobSummary` shape directly. */
export interface InboundWatchResult {
  [key: string]: number;
  servers: number;
  read: number;
  emitted: number;
  dropped: number;
  errors: number;
}

export async function runInboundWatch(): Promise<InboundWatchResult> {
  const result: InboundWatchResult = { servers: 0, read: 0, emitted: 0, dropped: 0, errors: 0 };

  // Only servers that actually have rules. `listEnabled` is one indexed read across the
  // instance, versus a per-server probe that would cost SSH on every box every minute.
  const rules = await repos.mailInbound.listEnabled().catch(() => []);
  if (rules.length === 0) return result;

  // The addresses this instance sends its OWN mail from. Passed into the loop guard so a
  // notification email that lands back inside a watched domain is recognised as ours and
  // cannot feed itself.
  const openshipSenders = await getInstanceSmtpSenders().catch(() => []);

  const byServer = new Map<string, string>();
  for (const rule of rules) byServer.set(rule.serverId, rule.organizationId);

  for (const [serverId, organizationId] of byServer) {
    result.servers++;
    try {
      const r = await runInboundForServer({ serverId, organizationId, openshipSenders });
      result.read += r.read;
      result.emitted += r.emitted;
      result.dropped += r.dropped;
      if (r.errors.length > 0) {
        result.errors += r.errors.length;
        // Per-domain failures are already summarized by runInboundForServer. Logged rather
        // than thrown: one unreachable mail box must not stop the rest of the sweep.
        console.warn(`[mail:inbound-watch] ${serverId}: ${r.errors.join("; ")}`);
      }
    } catch (err) {
      result.errors++;
      console.warn(`[mail:inbound-watch] ${serverId} failed: ${safeErrorMessage(err)}`);
    }
  }

  return result;
}

export interface InboundReconcileResult {
  [key: string]: number;
  servers: number;
  armed: number;
  disarmed: number;
  refused: number;
  errors: number;
}

/**
 * The `mail:inbound-reconcile` job body — drift repair for what is armed on each engine.
 *
 * `reconcileDomains` existed with no caller at all (GH-559), which left three drifts
 * permanent. The write path now disarms what it orphans, so this is the backstop rather
 * than the only defence — but it is the only thing that fixes:
 *
 *   - a domain a `scope: "all"` rule should cover that was ADDED AFTER the rule. There is
 *     no global BCC in the shipped config, so "all" is a real per-domain fan-out and a new
 *     domain is invisible to it until something re-arms;
 *   - an arm or disarm that failed mid-write (the atomicity gap capture.ts documents);
 *   - a collector an operator deleted by hand from the Mailboxes tab.
 *
 * Slow cadence on purpose: every pass costs SSH per mail server, and none of the drifts
 * above are latency-sensitive — the expensive one (an unpruned collector filling
 * /var/vmail) is now closed on the write path, so this only has to catch the residue.
 */
export async function runInboundReconcile(): Promise<InboundReconcileResult> {
  const result: InboundReconcileResult = {
    servers: 0,
    armed: 0,
    disarmed: 0,
    refused: 0,
    errors: 0,
  };

  const rules = await repos.mailInbound.listEnabled().catch(() => []);
  if (rules.length === 0) return result;

  // Group the WANTED set per server. `all` short-circuits the domain list: reconcile
  // resolves it against the engine's real domains, which is the whole point.
  const wantedByServer = new Map<string, { domains: Set<string>; all: boolean }>();
  for (const rule of rules) {
    let w = wantedByServer.get(rule.serverId);
    if (!w) {
      w = { domains: new Set<string>(), all: false };
      wantedByServer.set(rule.serverId, w);
    }
    if ((rule.scope as MailInboundScope) === "all") {
      w.all = true;
      continue;
    }
    const domain = ruleDomain({ scope: rule.scope as MailInboundScope, target: rule.target });
    if (domain) w.domains.add(domain);
  }

  for (const [serverId, wanted] of wantedByServer) {
    result.servers++;
    try {
      const r = await reconcileDomains(serverId, wanted);
      result.armed += r.armed.length;
      result.disarmed += r.disarmed.length;
      result.refused += r.refused.length;
      if (r.refused.length > 0) {
        // A foreign BCC is reported, never touched — the operator has to resolve it.
        console.warn(
          `[mail:inbound-reconcile] ${serverId}: left alone (foreign BCC or failed arm): ${r.refused.join(", ")}`,
        );
      }
    } catch (err) {
      result.errors++;
      console.warn(`[mail:inbound-reconcile] ${serverId} failed: ${safeErrorMessage(err)}`);
    }
  }

  return result;
}
