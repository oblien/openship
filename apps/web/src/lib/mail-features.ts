import type { FeatureIllustrationName } from "@repo/ui/illustrations";

/** Mail administration capabilities shared by the homepage and product page. */
export const MAIL_FEATURES = [
  {
    id: "accounts",
    illustration: "mail",
    title: "Domains & mailboxes",
    description: "Create accounts, set mailbox quotas, and manage multiple domains from one panel.",
    href: "/docs/dashboard/emails#domains",
  },
  {
    id: "aliases",
    illustration: "edge-routing",
    title: "Aliases & forwarding",
    description: "Give your team shared addresses, forward messages, and set up catch-all aliases.",
    href: "/docs/dashboard/emails#aliases",
  },
  {
    id: "delivery",
    illustration: "domains-ssl",
    title: "Delivery & DNS",
    description: "Check your mail records, choose direct delivery or an SMTP relay, and send a test message.",
    href: "/docs/guides/email-webmail/relays",
  },
  {
    id: "health",
    illustration: "logs-monitoring",
    title: "Health & protection",
    description: "Inspect services, logs, the mail queue, and Fail2ban bans when delivery needs attention.",
    href: "/docs/dashboard/emails#health",
  },
  {
    id: "backups",
    illustration: "backups-restore",
    title: "Backups & recovery",
    description: "Schedule backups of your mail configuration and messages. Restore them or move to another server.",
    href: "/docs/dashboard/emails#backup",
  },
  {
    id: "notifications",
    illustration: "notifications",
    title: "Mail notifications",
    description: "Route new-mail alerts to your notification channels, with rules for mailboxes, domains, or senders.",
    href: "/docs/dashboard/emails#notifications",
  },
] satisfies Array<{
  id: string;
  illustration: FeatureIllustrationName;
  title: string;
  description: string;
  href: string;
}>;
