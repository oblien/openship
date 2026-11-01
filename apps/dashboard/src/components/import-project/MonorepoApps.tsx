"use client";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { RepositoryAppPicker } from "./RepositoryAppPicker";
import { Icon as UiIcon } from "@repo/ui/icons";

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
import { useDeployment } from "@/context/DeploymentContext";
import { usePlatform } from "@/context/PlatformContext";
import { MonorepoAppProvider } from "@/context/deployment/MonorepoAppProvider";
import type { MonorepoAppConfig } from "@/context/deployment/types";
import { getModeSwitchUpdates } from "@/context/deployment/mode-config";
import { Checkbox } from "@/components/ui/Checkbox";
import { getFrameworkConfig } from "./Frameworks";
import ProjectSettings from "./ProjectSettings";
import BuildSettings from "./BuildSettings";
import EnvironmentVariables from "./EnvironmentVariables";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Input } from "@/components/ui/input";

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
function previewSubAppHost(app: MonorepoAppConfig, baseDomain: string): string | null {
  if (!baseDomain || app.exposed === false) return null;
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
    <div className="bg-card rounded-2xl">
      <div className="px-5 py-5 space-y-4">
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
            <UiIcon name="layers" className="w-4 h-4 text-primary" />
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
            <label htmlFor="monorepo-package-manager" className="text-sm font-medium text-foreground mb-1.5 block">{w.packageManager}</label>
            <Input
              dir="ltr"
              variant="filled"
              type="text"
              id="monorepo-package-manager"
              value={workspace.packageManager}
              onChange={(e) => setWorkspace({ packageManager: e.target.value })}
              className="font-mono"
            />
          </div>
          <div>
            <label htmlFor="monorepo-prepare-command" className="text-sm font-medium text-foreground mb-1.5 block">{w.prepareCommand}</label>
            <Input
              dir="ltr"
              variant="filled"
              type="text"
              id="monorepo-prepare-command"
              value={workspace.prepareCommand}
              onChange={(e) => setWorkspace({ prepareCommand: e.target.value })}
              placeholder="pnpm install -w"
              className="font-mono"
            />
            <p className="mt-1 text-xs text-muted-foreground">
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
  const { t } = useI18n();
  const a = t.importProject.monorepo.app;
  const apps = config.monorepoApps ?? [];
  const [expanded, setExpanded] = useState(false);
  const [pickingFolder, setPickingFolder] = useState(false);
  const frameworkConfig = getFrameworkConfig(app.framework);

  const setEnabled = (enabled: boolean) =>
    updateConfig({
      monorepoApps: apps.map((candidate) =>
        candidate.id === app.id ? { ...candidate, enabled } : candidate,
      ),
    });

  const previewHost = previewSubAppHost(app, baseDomain);

  return (
    <div className="bg-card rounded-2xl overflow-hidden">
      {pickingFolder && (
        <RepositoryAppPicker
          app={app}
          onClose={() => setPickingFolder(false)}
          onAdd={(next) => {
            updateConfig({
              monorepoApps: apps.map((candidate) => (candidate.id === app.id ? next : candidate)),
            });
            setPickingFolder(false);
          }}
        />
      )}
      {/* Header row */}
      <div className="flex items-center gap-3 px-5 py-4">
        <button
          type="button"
          onClick={() => setExpanded((e) => !e)}
          className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-muted/40 transition-colors"
          aria-label={expanded ? a.collapse : a.expand}
        >
          {expanded ? (
            <UiIcon name="chevron-down" className="w-4 h-4 text-muted-foreground" />
          ) : (
            <UiIcon name="chevron-right" className="w-4 h-4 text-muted-foreground rtl:rotate-180" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <h4 className="text-[15px] font-semibold text-foreground truncate">{app.name}</h4>
            <span className="text-xs text-muted-foreground truncate">{app.rootDirectory}</span>
          </div>
          <div className="flex items-center gap-3 mt-0.5 text-xs text-muted-foreground flex-wrap">
            <span>{frameworkConfig.name}</span>
            {app.hasServer && app.port && (
              <span>{interpolate(a.portSuffix, { port: String(app.port) })}</span>
            )}
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

      {/* Shared app editors write only to this app. Domains use the sidebar editor. */}
      {expanded && app.enabled && (
        <div className="border-t border-border/40 bg-muted/10 px-5 py-5 space-y-5">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="min-w-0 truncate font-mono text-muted-foreground">
              {app.rootDirectory}
            </span>
            {!config.uploadSessionId && (
              <Button variant="secondary" onClick={() => setPickingFolder(true)}>
                {t.importProject.monorepo.selection.chooseFolder}
              </Button>
            )}
          </div>
          <MonorepoAppProvider index={index}>
            <ProjectSettings />
            <BuildSettings allowWorker={false} />
            <EnvironmentVariables />
          </MonorepoAppProvider>
        </div>
      )}
    </div>
  );
};

const MONOREPO_MODE_OPTIONS = [
  { id: "services" as const, icon: "layers" as const },
  { id: "single" as const, icon: "code" as const },
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
  const [choosing, setChoosing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const copy = mr.selection;
  const choose = () => {
    setSelection(new Set(apps.filter((app) => app.enabled).map((app) => app.id)));
    setChoosing(true);
  };

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

  return (
    <div className="min-w-0 space-y-5">
      {adding && (
        <RepositoryAppPicker
          onClose={() => setAdding(false)}
          onAdd={(app) => {
            updateConfig({ monorepoApps: [...apps, app] });
            setAdding(false);
          }}
        />
      )}
      {choosing && (
        <Modal
          isOpen
          onClose={() => setChoosing(false)}
          width="640px"
          maxWidth="calc(100vw - 32px)"
          footer={
            <div className="flex items-center justify-between gap-3 p-4">
              <span className="text-sm text-muted-foreground">
                {interpolate(copy.selected, { count: String(selection.size) })}
              </span>
              <div className="flex gap-2">
                <Button variant="secondary" onClick={() => setChoosing(false)}>
                  {copy.cancel}
                </Button>
                <Button
                  onClick={() => {
                    updateConfig({
                      monorepoApps: apps.map((app) => ({ ...app, enabled: selection.has(app.id) })),
                    });
                    setChoosing(false);
                  }}
                >
                  {copy.applySelection}
                </Button>
              </div>
            </div>
          }
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="choose-apps-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") setChoosing(false);
            }}
            className="p-5 space-y-4"
          >
            <div className="pe-8">
              <h2 id="choose-apps-title" className="text-lg font-semibold">
                {copy.chooseApps}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">{copy.chooseHint}</p>
            </div>
            <div className="space-y-1">
              {apps.map((app) => (
                <label
                  key={app.id}
                  className="flex cursor-pointer items-center gap-3 rounded-xl bg-background p-3 hover:bg-muted/60"
                >
                  <Checkbox
                    checked={selection.has(app.id)}
                    onCheckedChange={(checked) =>
                      setSelection((previous) => {
                        const next = new Set(previous);
                        if (checked) next.add(app.id);
                        else next.delete(app.id);
                        return next;
                      })
                    }
                    aria-label={app.name}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{app.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {app.rootDirectory} · {app.framework}
                    </span>
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {app.suggested === false ? copy.manualReview : copy.detectedApp}
                  </span>
                </label>
              ))}
            </div>
          </div>
        </Modal>
      )}

      {/* Header banner */}
      <div className="bg-card rounded-2xl px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
            <UiIcon name="grid" className="w-4 h-4 text-primary" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-semibold text-foreground">{copy.title}</h3>
            <p className="text-xs text-muted-foreground">
              {isSingleAppMode
                ? mr.header.singleDesc
                : interpolate(copy.selected, { count: String(selectedCount) })}
            </p>
          </div>
          <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" onClick={choose}>
              {selectedCount ? copy.changeSelection : copy.chooseApps}
            </Button>
            {!isSingleAppMode && !config.uploadSessionId && (
              <Button variant="secondary" onClick={() => setAdding(true)}>
                <UiIcon name="plus" className="size-4" />
                {copy.addMore}
              </Button>
            )}
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
          {selectedCount > 0 ? (
            <>
              <div className="space-y-3">
                {apps.map((app, i) =>
                  app.enabled ? <AppCard key={app.id} app={app} index={i} /> : null,
                )}
              </div>
              <WorkspaceCard />
            </>
          ) : (
            <p className="px-1 text-sm text-muted-foreground">{copy.empty}</p>
          )}
        </>
      ) : (
        <>
          <div className="rounded-xl border border-border/50 bg-muted/20 p-4">
            <p className="text-sm text-muted-foreground leading-relaxed">{mr.singleNote}</p>
          </div>
          {/* Single-app commands editor - mirrors ComposeServices' inline
              <BuildSettings allowWorker={false} /> for compose's single-app mode. The mode
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
      <div className="bg-card rounded-2xl px-5 py-4">
        <button
          type="button"
          onClick={() => setModeOptionsOpen((open) => !open)}
          className="flex w-full items-center justify-between gap-4 text-start"
        >
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-xl bg-muted/40">
              <UiIcon name="sliders" className="size-4 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-semibold text-foreground">{mr.deploymentMode}</p>
              <p className="text-xs text-muted-foreground">
                {interpolate(mr.deploymentModeDesc, { mode: modeText[selectedMode.id].label })}
              </p>
            </div>
          </div>
          {modeOptionsOpen ? (
            <UiIcon name="chevron-up" className="size-4 text-muted-foreground" />
          ) : (
            <UiIcon name="chevron-down" className="size-4 text-muted-foreground" />
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
                      <UiIcon name={Icon} className="size-4" />
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
