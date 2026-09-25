"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Inline team-invite guidance for a self-hosted instance with no public URL yet.
 *
 * Instead of dead-ending invites, we tell the operator exactly what to do based
 * on the instance-reachability detector (the single source of truth from the API
 * `getInstanceReachability`): install Openship as an app, or add a domain to it —
 * with a direct link to the Openship app's Domains tab. Renders nothing once the
 * instance is reachable (then invites are on).
 */

import Link from "next/link";
import { SettingsSection } from "./SettingsSection";
import { useI18n } from "@/components/i18n-provider";

export interface TeamReachability {
  configured: boolean;
  url: string | null;
  source: "env" | "self-app" | null;
  selfAppInstalled: boolean;
  selfAppProjectId: string | null;
  selfAppHasDomain: boolean;
  selfAppHasVerifiedDomain: boolean;
}

export function TeamReachabilityCard({ reachability }: { reachability: TeamReachability | null }) {
  const { t } = useI18n();
  const w = t.settings.team.reachability;
  const r = reachability;

  // Reachable → nothing to guide; the invite UI is enabled.
  if (r?.configured) return null;

  let title = w.notInstalledTitle;
  let body = w.notInstalledBody;
  let href: string | null = null;
  let action = "";

  if (r?.selfAppInstalled && r.selfAppProjectId) {
    const domains = `/projects/${r.selfAppProjectId}/domains`;
    if (!r.selfAppHasDomain) {
      title = w.noDomainTitle;
      body = w.noDomainBody;
      href = domains;
      action = w.addDomain;
    } else if (!r.selfAppHasVerifiedDomain) {
      title = w.pendingTitle;
      body = w.pendingBody;
      href = domains;
      action = w.viewDomain;
    }
  }

  return (
    <SettingsSection
      icon={"globe"}
      title={title}
      description={w.description}
      iconBg="bg-primary/10"
      iconColor="text-primary"
    >
      <div className="space-y-4">
        <p className="text-sm leading-relaxed text-muted-foreground">{body}</p>
        {href && (
          <Link
            href={href}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {action}
            <UiIcon name="arrow-right" className="size-4 rtl:rotate-180" />
          </Link>
        )}
      </div>
    </SettingsSection>
  );
}
