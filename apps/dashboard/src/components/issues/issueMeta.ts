import {
  AlertTriangle,
  ArrowUpCircle,
  Container,
  Download,
  Globe,
  HeartPulse,
  HelpCircle,
  Layers,
  Lock,
  Mail,
  Package,
  Plug,
  Route,
  RotateCcw,
  Server,
  ServerOff,
  Split,
  XCircle,
  FolderKanban,
} from "lucide-react";
import type { ComponentType } from "react";

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

export const KIND_ICON: Record<IssueKind, ComponentType<{ className?: string }>> = {
  deploy_blocked: XCircle,
  prompt: HelpCircle,
  partial_decision: Split,
  routing_unsynced: Route,
  domain_unverified: Globe,
  ssl_error: Lock,
  port_advisory: Plug,
  workload_unhealthy: HeartPulse,
  workload_crash_loop: RotateCcw,
  workload_down: Container,
  server_unreachable: ServerOff,
  edge_down: Globe,
  edge_absent: Download,
  mail_down: Mail,
  update_available: Package,
  component_behind: ArrowUpCircle,
};

export const SCOPE_ICON: Record<IssueScope, ComponentType<{ className?: string }>> = {
  platform: Layers,
  server: Server,
  project: FolderKanban,
  domain: Globe,
};

/**
 * Group order: outward from the thing that takes everything else down with it.
 * A broken control plane explains every other row, an unreachable server explains
 * its projects, and a domain problem is the narrowest blast radius.
 */
export const SCOPE_ORDER: IssueScope[] = ["platform", "server", "project", "domain"];

/** Fallback icon for a kind a newer API added and this build doesn't know. */
export const UNKNOWN_KIND_ICON = AlertTriangle;
