import type { IconName } from "@repo/ui/icons";

import type { IssueKind, IssueScope, IssueSeverity } from "@/lib/api/issues";
import type { AlertTone } from "@/components/overview/AlertPanel";

/**
 * The visual vocabulary of the issue feed, in one table each.
 *
 * Kept out of the row component so the mapping is a value a test can assert over
 * (every `IssueKind` has an icon — the compiler enforces it via `Record`) rather
 * than a switch buried in JSX.
 */

/** Severity → the shared alert tone. The only place the two vocabularies meet. */
export const SEVERITY_TONE: Record<IssueSeverity, AlertTone> = {
  outage: "danger",
  action_required: "warning",
  advisory: "neutral",
};

/**
 * The tone a scope PANEL wears. An advisory is muted while something louder shares
 * the page — so "a new version exists" can't be mistaken for "down" at a glance —
 * but amber when advisories stand alone, the same identity the home Updates card
 * carries. `standAlone` is true when nothing on the page outranks an advisory.
 */
export function panelTone(severity: IssueSeverity, standAlone: boolean): AlertTone {
  const tone = SEVERITY_TONE[severity] ?? "warning";
  return tone === "neutral" && standAlone ? "warning" : tone;
}

export const KIND_ICON: Record<IssueKind, IconName> = {
  deploy_blocked: "x-circle",
  prompt: "help-circle",
  partial_decision: "split",
  routing_unsynced: "route",
  domain_unverified: "globe",
  ssl_error: "lock",
  port_advisory: "plug",
  workload_unhealthy: "activity",
  workload_crash_loop: "rotate-left",
  workload_down: "power",
  server_unreachable: "server-off",
  edge_down: "globe",
  edge_absent: "download",
  mail_down: "mail",
  update_available: "arrow-up-circle",
  component_behind: "arrow-up-circle",
};

export const SCOPE_ICON: Record<IssueScope, IconName> = {
  platform: "layers",
  server: "server",
  project: "project",
  domain: "globe",
};

/**
 * Group order: outward from the thing that takes everything else down with it.
 * A broken control plane explains every other row, an unreachable server explains
 * its projects, and a domain problem is the narrowest blast radius.
 */
export const SCOPE_ORDER: IssueScope[] = ["platform", "server", "project", "domain"];

/** Fallback icon for a kind a newer API added and this build doesn't know. */
export const UNKNOWN_KIND_ICON = "warning";
