"use client";

/**
 * Monorepo deploy form.
 *
 * Renders when the prepare endpoint detected a workspace manifest + 2 or more
 * deployable sub-apps. Top: shared workspace install settings (package
 * manager + root install command). Below: one expandable card per sub-app,
 * each wrapped in `MonorepoAppProvider` so the existing single-app form
 * components (ProjectSettings + BuildSettings + EnvironmentVariables) write
 * into that sub-app's slice without modification.
 */

import React, { useCallback, useState } from "react";
import { Boxes, ChevronDown, ChevronRight, ChevronUp, Code2, Layers, Settings2 } from "lucide-react";
import { useDeployment } from "@/context/DeploymentContext";
import { usePlatform } from "@/context/PlatformContext";
import { MonorepoAppProvider } from "@/context/deployment/MonorepoAppProvider";
import type { MonorepoAppConfig, PublicEndpoint } from "@/context/deployment/types";
import { createPublicEndpoint } from "@/context/deployment/types";
import { getModeSwitchUpdates } from "@/context/deployment/mode-config";
import { Checkbox } from "@/components/ui/Checkbox";
import { getFrameworkConfig } from "./Frameworks";
import ProjectSettings from "./ProjectSettings";
import BuildSettings from "./BuildSettings";
import EnvironmentVariables from "./EnvironmentVariables";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useDefaultDomainType } from "@/context/CloudContext";

// Tiny class-joining helper to avoid pulling in a util just for the toggle.
function cn(...parts: Array<string | false | undefined | null>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Resolve a default free-subdomain label for a monorepo sub-app, used to
 * preview the URL in the row header before deploy. If the user has
 * already set a custom label on the sub-app's first endpoint we honor it;
 * otherwise we fall back to "<app-name>-<project-slug>" so each sub-app
 * gets a visibly distinct host that matches what the backend will mint
 * at deploy time.
 */
function previewSubAppHost(app: MonorepoAppConfig, projectName: string, baseDomain: string): string | null {
  if (!baseDomain) return null;
  const ep = app.publicEndpoints?.[0];
  if (ep?.domainType === "custom" && ep.customDomain) {
    return ep.customDomain;
  }
  // Only a slug the user actually chose. The `<app>-<project>` fallback that used
  // to stand in here previewed a host nothing creates: a free route with no
  // subdomain is dropped when the endpoints are resolved, so the sub-app deploys
  // reachable on its port and that hostname never exists.
  const label = ep?.domain?.trim();
  if (!label) return null;
  return `${label}.${baseDomain}`;
}

const WorkspaceCard: React.FC = () => {
  const { config, updateConfig } = useDeployment();
  const { t } = useI18n();
  const w = t.importProject.monorepo.workspace;
  const workspace = config.monorepoWorkspace;
  if (!workspace) return null;

  const setWorkspace = (patch: Partial<typeof workspace>) => {
    updateConfig({ monorepoWorkspace: { ...workspace, ...patch } });
  };

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="px-5 py-5 space-y-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Layers className="w-4 h-4 text-primary" />
          </div>
          <div>
            <h3 className="text-[15px] font-semibold text-foreground">{w.title}</h3>
            <p className="text-xs text-muted-foreground">
              {w.subtitle}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{w.packageManager}</label>
            <input
              type="text"
              value={workspace.packageManager}
              onChange={(e) => setWorkspace({ packageManager: e.target.value })}
              className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">{w.prepareCommand}</label>
            <input
              type="text"
              value={workspace.prepareCommand}
              onChange={(e) => setWorkspace({ prepareCommand: e.target.value })}
              placeholder="pnpm install -w"
              className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <p className="mt-1 text-[11px] text-muted-foreground/80">
              {w.chainPrefix} <code>&amp;&amp;</code> {w.chainSuffix}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

const AppCard: React.FC<{ app: MonorepoAppConfig; index: number }> = ({ app, index }) => {
  const { config, updateConfig } = useDeployment();
  const { baseDomain } = usePlatform();
  const newEndpointDomainType = useDefaultDomainType();
  const { t } = useI18n();
  const a = t.importProject.monorepo.app;
  const apps = config.monorepoApps ?? [];
  // Only the first sub-app expands on mount. Operators usually deal with
  // sub-apps one at a time - opening N at once makes the page very tall
  // and most of those cards stay scrolled past. Each card is one click
  // away from its details via the chevron.
  const [expanded, setExpanded] = useState(index === 0);
  const frameworkConfig = getFrameworkConfig(app.framework);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      const next = apps.slice();
      next[index] = { ...app, enabled };

      // Sync publicEndpoints to the enabled set. The seed in
      // useDeploymentConfig.ts mints one endpoint per sub-app with the
      // label `{slugify(app.name)}-{slugify(projectDomain)}`, so the
      // app's slug appears as a stable substring in the endpoint's domain
      // - we use that to preserve any custom-domain edits the user made
      // on already-enabled apps while dropping endpoints for disabled
      // apps and re-seeding defaults for newly re-enabled ones.
      const slugify = (v: string) =>
        v.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
      const currentEndpoints: PublicEndpoint[] = config.publicEndpoints ?? [];
      const projectSlug = slugify(config.projectName || "app");
      const nextEndpoints: PublicEndpoint[] = next
        .filter((a) => a.enabled)
        .map((a) => {
          const appSlug = slugify(a.name);
          const existing = currentEndpoints.find(
            (ep) =>
              (ep.domain && ep.domain.includes(appSlug)) ||
              (ep.customDomain && ep.customDomain.includes(appSlug)),
          );
          if (existing) return existing;
          return createPublicEndpoint({
            port: a.port || "",
            targetPath: a.hasServer ? "" : "/",
            domain: `${appSlug}-${projectSlug}`,
            domainType: newEndpointDomainType,
          });
        });

      updateConfig({ monorepoApps: next, publicEndpoints: nextEndpoints });
    },
    [apps, app, index, config.projectName, config.publicEndpoints, newEndpointDomainType, updateConfig],
  );

  // Preview the host this sub-app will be served on - same logic the
  // deploy backend uses to mint the default free subdomain. Lets the
  // operator see "→ apps-dashboard-diavira.opsh.io" right in the row
  // header without having to expand the card or look at the right
  // sidebar (which still only shows the PROJECT-level endpoint).
  const previewHost = previewSubAppHost(app, config.projectName ?? "", baseDomain);

  return (
    <div className={`bg-card rounded-2xl border ${app.enabled ? "border-border/50" : "border-border/30 opacity-70"} overflow-hidden`}>
      {/* Header row */}
      <div className="flex items-center gap-3 px-5 py-4">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-muted/40 transition-colors"
          aria-label={expanded ? a.collapse : a.expand}
        >
          {expanded ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground rtl:rotate-180" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <h4 className="text-[15px] font-semibold text-foreground truncate">{app.name}</h4>
            <span className="text-xs text-muted-foreground truncate">{app.rootDirectory}</span>
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
            <span>{frameworkConfig.name}</span>
            {app.port && <span>{interpolate(a.portSuffix, { port: String(app.port) })}</span>}
            {app.packageManager && <span>· {app.packageManager}</span>}
            {/* Preview domain - only when this sub-app is actually going
                to deploy (enabled) AND we can compute a host. Disabled
                apps render the metadata greyed without the URL so it's
                obvious the host isn't being claimed. */}
            {app.enabled && previewHost && (
              <>
                <span className="text-muted-foreground/50">→</span>
                <span className="text-foreground/80 truncate">{previewHost}</span>
              </>
            )}
          </div>
        </div>

        <label className="flex items-center gap-2 cursor-pointer select-none">
          <Checkbox
            checked={app.enabled}
            onCheckedChange={setEnabled}
            aria-label={a.deployAria}
          />
          <span className="text-xs text-muted-foreground">{a.deploy}</span>
        </label>
      </div>

      {/* Expanded body - single-app form components scoped to this
          sub-app via MonorepoAppProvider. Domain control lives only in
          the right sidebar's <PublicEndpointsCard>, which renders one
          card per sub-app from the seeded `config.publicEndpoints`. We
          deliberately do NOT render a domain editor inline here - that
          would duplicate the same field in two places and the two
          slices (project-level publicEndpoints vs sub-app slice) would
          drift apart on edit. One canonical surface, no duplication. */}
      {expanded && app.enabled && (
        <div className="border-t border-border/40 bg-muted/10 px-5 py-5 space-y-5">
          <MonorepoAppProvider index={index}>
            <ProjectSettings />
            <BuildSettings />
            <EnvironmentVariables />
          </MonorepoAppProvider>
        </div>
      )}
    </div>
  );
};

const MONOREPO_MODE_OPTIONS = [
  { id: "services" as const, icon: Layers },
  { id: "single" as const, icon: Code2 },
];

const MonorepoApps: React.FC = () => {
  const { config, updateConfig } = useDeployment();
  const { t } = useI18n();
  const mr = t.importProject.monorepo;
  const modeText: Record<"services" | "single", { label: string; description: string }> = {
    services: { label: mr.modes.servicesLabel, description: mr.modes.servicesDesc },
    single: { label: mr.modes.singleLabel, description: mr.modes.singleDesc },
  };
  const apps = config.monorepoApps ?? [];
  const selectedCount = apps.filter((a) => a.enabled).length;
  const isSingleAppMode = config.serviceDeploymentMode === "single";
  const [modeOptionsOpen, setModeOptionsOpen] = useState(false);

  // Mirrors the compose-side mode switch - the same `getModeSwitchUpdates`
  // helper covers monorepo (it branches on `projectType` internally). When
  // the operator flips to "Single app", the helper picks a primary sub-app,
  // promotes its install/build/start commands, and collects every enabled
  // sub-app's port as exposed endpoints. Flipping back to "Per-app runtime"
  // restores the saved multi-app snapshot.
  const setDeploymentMode = useCallback(
    (mode: "services" | "single") => {
      updateConfig(getModeSwitchUpdates(config, mode));
    },
    [config, updateConfig],
  );

  const selectedMode =
    MONOREPO_MODE_OPTIONS.find((option) => option.id === config.serviceDeploymentMode) ??
    MONOREPO_MODE_OPTIONS[0];

  if (apps.length === 0) return null;

  return (
    <div className="space-y-5">
      {/* Header banner */}
      <div className="bg-card rounded-2xl border border-border/50 px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <Boxes className="w-4 h-4 text-primary" />
          </div>
          <div className="flex-1">
            <h3 className="text-[15px] font-semibold text-foreground">
              {interpolate(mr.header.title, { count: String(apps.length) })}
            </h3>
            <p className="text-xs text-muted-foreground">
              {isSingleAppMode
                ? mr.header.singleDesc
                : interpolate(mr.header.multiDesc, { selected: String(selectedCount), total: String(apps.length) })}
            </p>
          </div>
        </div>
      </div>

      {/* Per-app runtime: workspace install + per-sub-app cards.
          Single app: collapsed view - the project-level BuildSettings on
          the deploy page already covers commands, so we don't duplicate
          the sub-app cards here. The operator can flip back to per-app
          via the mode toggle below at any time. */}
      {!isSingleAppMode ? (
        <>
          <WorkspaceCard />

          <div className="space-y-3">
            {apps.map((app, i) => (
              <AppCard key={app.id} app={app} index={i} />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
            <p className="text-sm text-muted-foreground leading-relaxed">
              {mr.singleNote}
            </p>
          </div>
          {/* Single-app commands editor - mirrors ComposeServices' inline
              <BuildSettings /> for compose's single-app mode. The mode
              switch already promoted one sub-app's install/build/start
              into config.options; this UI now lets the operator edit
              them like any single-app project. */}
          <BuildSettings />
        </>
      )}

      {/* Deployment-mode toggle - same affordance compose has. Lives at
          the bottom of the monorepo card so the per-app list is the
          first thing the operator sees, with the "switch shape" option
          below as an advanced flip. */}
      <div className="bg-card rounded-2xl border border-border/50 px-5 py-4">
        <button
          type="button"
          onClick={() => setModeOptionsOpen((open) => !open)}
          className="flex w-full items-center justify-between gap-4 text-start"
        >
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-muted/40">
              <Settings2 className="size-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{mr.deploymentMode}</p>
              <p className="text-xs text-muted-foreground">
                {interpolate(mr.deploymentModeDesc, { mode: modeText[selectedMode.id].label })}
              </p>
            </div>
          </div>
          {modeOptionsOpen ? (
            <ChevronUp className="size-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-4 text-muted-foreground" />
          )}
        </button>

        {modeOptionsOpen && (
          <div className="mt-4 rounded-xl border border-border/50 bg-muted/20 p-4">
            <div className="grid gap-2 sm:grid-cols-2">
              {MONOREPO_MODE_OPTIONS.map((option) => {
                const Icon = option.icon;
                const selected = config.serviceDeploymentMode === option.id;
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => setDeploymentMode(option.id)}
                    className={cn(
                      "flex items-start gap-3 rounded-xl border p-3 text-start transition-colors",
                      selected
                        ? "border-primary/40 bg-primary/10 text-foreground"
                        : "border-border/50 bg-background/50 text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg",
                        selected
                          ? "bg-primary/15 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">{modeText[option.id].label}</span>
                      <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                        {modeText[option.id].description}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default MonorepoApps;
