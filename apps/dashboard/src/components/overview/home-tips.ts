/**
 * Product quick-tips shown on the dashboard home card.
 *
 * One is picked at RANDOM per mount (i.e. per visit to Home) whenever there's
 * no more urgent contextual nudge (connect GitHub / create your first project).
 *
 * Copy is TRANSLATION-BASED: each tip's `id` maps to an i18n entry at
 * `overview.homeTip.tips.<id>` → { text, label } (see the locale files). To add
 * a tip, add the `{ id, href }` here AND the matching copy under that key. Set
 * `selfHostedOnly` for guidance specific to self-hosting, such as SSH server
 * connections and mail setup, so it's never shown on cloud.
 */
export interface ProductTip {
  /** i18n key under `overview.homeTip.tips.<id>` → { text, label }. */
  id: string;
  /** In-app destination the tip links to. */
  href: string;
  /** Hide guidance specific to self-hosting on Cloud installs. */
  selfHostedOnly?: boolean;
}

export const PRODUCT_TIPS: ProductTip[] = [
  { id: "envVars", href: "/projects" },
  { id: "customDomain", href: "/projects" },
  { id: "autoDeploy", href: "/settings" },
  { id: "rollback", href: "/deployments" },
  { id: "apps", href: "/apps/new" },
  { id: "servers", href: "/servers", selfHostedOnly: true },
  { id: "jobs", href: "/jobs" },
  { id: "backups", href: "/backups" },
  { id: "mail", href: "/emails", selfHostedOnly: true },
  { id: "team", href: "/settings?tab=team" },
];
