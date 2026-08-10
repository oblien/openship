/**
 * Which domain type a NEW endpoint should open on.
 *
 * A free `.opsh.io` subdomain routes through Openship Cloud, and backend preflight
 * gates it on a Cloud connection — so on a self-hosted instance with none,
 * defaulting to "free" offers a dead end the user has to notice and undo. Default
 * those to their own domain instead. Cloud-connected instances (and SaaS/native,
 * where CloudContext forces `connected` true) keep "free".
 *
 * Every new-endpoint seed reads this: the deploy wizard (single-app + monorepo),
 * the one-click Apps install, the "+" add-domain button, Add Service. Kept
 * dependency-free so it's the one testable place the default can drift.
 * Components should reach for `useDefaultDomainType()` in CloudContext.
 */
export function defaultDomainType(cloudConnected: boolean): "free" | "custom" {
  return cloudConnected ? "free" : "custom";
}
