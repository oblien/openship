"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * Wizard "Routing" advanced section — a collapsible card wrapping the shared
 * RoutingConfigEditor, bound to the deployment config. Detected from the repo's
 * vercel.json at prepare; edits flow into `config.routingConfig` and are sent to
 * the backend on deploy (compiled to OpenResty for self-hosted).
 */

import React, { useState } from "react";
import { useDeployment } from "@/context/DeploymentContext";
import { RoutingConfigEditor } from "@/components/routing/RoutingConfigEditor";
import { useI18n } from "@/components/i18n-provider";

function countRules(cfg: DeploymentRoutingLike): number {
  return (
    (cfg?.rewrites?.length ?? 0) +
    (cfg?.redirects?.length ?? 0) +
    (cfg?.headers?.length ?? 0) +
    (cfg?.cleanUrls ? 1 : 0) +
    (cfg?.trailingSlash ? 1 : 0)
  );
}

type DeploymentRoutingLike =
  | {
      rewrites?: unknown[];
      redirects?: unknown[];
      headers?: unknown[];
      cleanUrls?: boolean;
      trailingSlash?: boolean;
    }
  | null
  | undefined;

const RoutingSection: React.FC = () => {
  const { config, updateConfig } = useDeployment();
  const { t } = useI18n();
  const r = t.importProject.routingSection;
  const routing = config.routingConfig;
  const count = countRules(routing);
  const [open, setOpen] = useState(false);

  // Only surface when routing rules were actually detected. With none there's
  // nothing to configure here — don't add an empty section to the wizard.
  if (count === 0) return null;

  return (
    <div className="bg-card rounded-2xl border border-border/50 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-5 py-4 text-start"
      >
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <UiIcon name="route" className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-foreground">
              {r.title} · {count}
            </h3>
            <p className="text-xs text-muted-foreground">
              {r.descDetected}
            </p>
          </div>
        </div>
        {open ? (
          <UiIcon name="chevron-up" className="size-4 text-muted-foreground" />
        ) : (
          <UiIcon name="chevron-down" className="size-4 text-muted-foreground" />
        )}
      </button>
      {open && (
        <div className="border-t border-border/40 bg-muted/10 px-5 py-5">
          <RoutingConfigEditor value={routing} onChange={(next) => updateConfig({ routingConfig: next })} />
        </div>
      )}
    </div>
  );
};

export default RoutingSection;
