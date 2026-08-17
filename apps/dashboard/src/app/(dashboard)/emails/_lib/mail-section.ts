"use client";

/**
 * Who owns navigation on /emails, and where a section's heading is rendered.
 *
 * In Openship Mail the rail lists the ten sections, so the page renders exactly
 * ONE heading and it names the section you're on: the in-page tab bar hides (the
 * rail is the tab bar) and each tab's own <h2> steps aside in favour of the page
 * header. Otherwise every section stacked "Email Server" over "Domains" and the
 * ten entries appeared twice on screen.
 *
 * Platform view is untouched: /emails stays one page with a tab bar, its title is
 * "Email Server", and each tab carries its own heading.
 */

import type { Dictionary } from "@/i18n";
import { usePlatform } from "@/context/PlatformContext";
import { useMailScope } from "@/context/MailScopeContext";
import type { MailTabKey } from "@/lib/mail-tabs";

/**
 * True when the mail rail is listing THIS server's sections.
 *
 * Gated on the rail's actual state, not merely on the view: its entries come from
 * a separate mail-server fetch (MailScopeContext), and while that's in flight or
 * after it fails the rail shows a single "Email" link. Hiding the tab bar and the
 * headings on `productView` alone would strand an operator on Overview with no
 * way to reach the other nine.
 */
export function useMailRailOwnsTabs(serverId: string | null): boolean {
  const { productView } = usePlatform();
  const mailScope = useMailScope();
  return (
    productView === "mail" &&
    mailScope.loaded &&
    !!serverId &&
    mailScope.activeServerId === serverId &&
    mailScope.activeServer?.completed === true
  );
}

export interface MailSectionHeading {
  title: string;
  description?: string;
}

/**
 * The heading the page header shows for `tab`, or null to keep the page's own
 * "Email Server" title.
 *
 * Reuses each section's existing strings rather than a parallel set of nav-shaped
 * ones — the heading an operator reads is the same sentence the tab used to print
 * for itself, just one level up. Overview returns null on purpose: it's the
 * server's front page, so "Email Server" IS its heading (and it has no <h2> of
 * its own to hoist).
 */
export function getMailSectionHeading(tab: MailTabKey, t: Dictionary): MailSectionHeading | null {
  const a = t.emailsAdmin;
  switch (tab) {
    case "domains":
      return { title: a.domains.heading, description: a.domains.description };
    case "mailboxes":
      return { title: a.mailboxes.heading, description: a.mailboxes.description };
    case "aliases":
      return { title: a.aliases.heading, description: a.aliases.description };
    case "notifications":
      return { title: a.notifications.heading, description: a.notifications.description };
    case "dns":
      return { title: a.dns.heading, description: a.dns.description };
    case "health":
      return { title: a.health.heading, description: a.health.description };
    case "backup":
      return { title: a.backup.heading, description: a.backup.description };
    case "sending":
      return { title: a.sending.title, description: a.sending.subtitle };
    // Advanced is a stack of sections (protocol / recovery tools / danger zone),
    // each with its own heading and none of them the tab's — so the page header
    // gets the rail's label and nothing below it moves.
    case "advanced":
      return { title: a.panel.tabs.advanced };
    default:
      return null;
  }
}
