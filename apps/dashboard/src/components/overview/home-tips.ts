/**
 * Product quick-tips shown on the dashboard home card.
 *
 * One is picked at RANDOM per mount (i.e. per visit to Home) whenever there's
 * no more urgent contextual nudge (connect GitHub / create your first project).
 *
 * Copy is TRANSLATION-BASED: each tip's `id` maps to an i18n entry at
 * `overview.homeTip.tips.<id>` → { text, label } (see the locale files). To add
 * a tip, add the `{ id, href }` here AND the matching copy under that key. Set
 * `selfHostedOnly` when the route only exists on a self-hosted instance
 * (servers, jobs, mail) so it's never shown on cloud.
 */
export interface ProductTip {
  /** i18n key under `overview.homeTip.tips.<id>` → { text, label }. */
  id: string;
  /** In-app destination the tip links to. */
  href: string;
  /** Hide on cloud installs — the route is self-hosted only. */
  selfHostedOnly?: boolean;
}

export const PRODUCT_TIPS: ProductTip[] = [
  { id: "envVars", href: "/projects" },
  { id: "customDomain", href: "/projects" },
  { id: "autoDeploy", href: "/settings" },
  { id: "rollback", href: "/deployments" },
  { id: "apps", href: "/apps" },
  { id: "servers", href: "/servers", selfHostedOnly: true },
  { id: "jobs", href: "/jobs", selfHostedOnly: true },
  { id: "backups", href: "/backups" },
  { id: "mail", href: "/emails", selfHostedOnly: true },
  { id: "team", href: "/settings?tab=team" },
];
