"use client";

import Link from "next/link";

import { useI18n } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";
import { describeBuildTarget } from "./deploy-target-label";

/**
 * WHERE this deploy lands, as a value for a details row — and a LINK to the machine when it is
 * one of yours.
 *
 * A component rather than a second string in `deploy-target-label`, because linking needs the
 * server ID and both progress screens (the single-app `DeploymentProcessing` and the compose
 * `ComposeSidebar`) render the same fact in the same place. They already shared the label
 * resolver and diverged on nothing else; one of them growing a link would be the start of "Server
 * · box-1" vs "box-1" drifting apart again.
 *
 * Only a server target links. Openship Cloud has no per-instance page to open, and `local` is the
 * box the dashboard is already running on — a link to "here" is a dead end dressed as an action.
 */
export function DeployTargetValue({
  config,
  className,
}: {
  config: { deployTarget: string; serverName?: string; serverId?: string };
  /** Applied to the text itself, so a caller can keep its own truncation. */
  className?: string;
}) {
  const { t } = useI18n();
  const label = describeBuildTarget(config, t as Dictionary);

  if (config.deployTarget !== "server" || !config.serverId) {
    return <span className={className}>{label}</span>;
  }

  return (
    <Link
      href={`/servers/${config.serverId}`}
      // Underline on hover only: this sits in a dense read-only details list, and a permanently
      // underlined value would read as the emphasis of the panel rather than as one row of it.
      className={`transition-colors hover:text-primary hover:underline ${className ?? ""}`}
      title={label}
    >
      {label}
    </Link>
  );
}

export default DeployTargetValue;
