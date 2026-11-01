"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Inline team-invite guidance for a self-hosted instance with no public URL yet.
 *
 * Instead of dead-ending invites, we tell the operator exactly what to do based
 * on the instance-reachability detector (the single source of truth from the API
 * `getInstanceReachability`): move through Instance location, or finish an
 * existing Openship app's domain. Renders nothing once the
 * instance is reachable (then invites are on).
 */

import Link from "next/link";
import { SettingsSection } from "./SettingsSection";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { InstanceMoveLink } from "@/components/instance/InstanceMoveLink";

export interface TeamReachability {
  configured: boolean;
  url: string | null;
  source: "env" | "self-app" | null;
  selfAppInstalled: boolean;
  selfAppProjectId: string | null;
  selfAppHasDomain: boolean;
  selfAppHasVerifiedDomain: boolean;
}

export function TeamReachabilityCard({
  reachability,
  canMigrate,
}: {
  reachability: TeamReachability | null;
  canMigrate: boolean;
}) {
  const { t } = useI18n();
  const w = t.settings.team.reachability;
  const copy = t.settings.instance.location;
  const r = reachability;

  // Reachable → nothing to guide; the invite UI is enabled.
  if (r?.configured) return null;

  let title = copy.teamAccessTitle;
  let body = copy.teamAccessHint;
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
      description={body}
      iconBg="bg-primary/10"
      iconColor="text-primary"
    >
      <div className="flex flex-wrap items-center gap-2">
        {href && (
          <Button asChild size="sm">
            <Link href={href}>
              {action}
              <UiIcon name="arrow-right" className="rtl:rotate-180" />
            </Link>
          </Button>
        )}
        {canMigrate ? (
          <InstanceMoveLink variant={href ? "ghost" : "secondary"} />
        ) : (
          <p className="text-xs text-muted-foreground">{copy.adminRequired}</p>
        )}
      </div>
    </SettingsSection>
  );
}
