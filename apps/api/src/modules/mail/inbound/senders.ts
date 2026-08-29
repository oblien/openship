/**
 * The addresses THIS instance sends its own mail from.
 *
 * This exists for exactly one reason: a notification about mail is itself mail. If an
 * inbound rule watches a domain that also receives Openship's own alerts — a support
 * address on the same engine, a member whose mailbox lives there — then the alert is
 * captured, matched, and emitted again. The loop only stops when a human notices.
 *
 * `loopGuard` takes these as data so it can stay pure. Two sources, because the instance
 * can send as either:
 *   - `instance_settings.smtpFrom`, i.e. whatever Settings→Email is configured with (the
 *     one sender for ALL system mail);
 *   - `openship@<domain>` for each provisioned mail server, the platform mailbox the mail
 *     module creates for itself.
 *
 * Best-effort and never fatal: a failure here must not stop the sweep, but it DOES widen
 * the loop window, so it is logged rather than swallowed silently.
 */

import { safeErrorMessage } from "@repo/core";
import { repos } from "@repo/db";
import { PLATFORM_LOCAL_PART } from "../admin/platform-mailbox.service";

export async function getInstanceSmtpSenders(): Promise<string[]> {
  const out = new Set<string>();

  try {
    const settings = await repos.instanceSettings.get();
    const from = settings?.smtpFrom?.trim().toLowerCase();
    // smtpFrom may be a display form (`Openship <a@b.com>`), so take the bare address.
    if (from) {
      const angled = from.match(/<([^>]+)>/);
      const address = (angled ? angled[1] : from).trim();
      if (address.includes("@")) out.add(address);
    }
  } catch (err) {
    console.warn(`[mail:inbound] could not read instance SMTP sender: ${safeErrorMessage(err)}`);
  }

  try {
    for (const server of await repos.mailServer.list()) {
      const domain = server.domain?.trim().toLowerCase();
      if (domain) out.add(`${PLATFORM_LOCAL_PART}@${domain}`);
    }
  } catch (err) {
    console.warn(`[mail:inbound] could not read mail server domains: ${safeErrorMessage(err)}`);
  }

  return [...out];
}
