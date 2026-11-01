"use client";

import { useState } from "react";
import { Icon } from "@repo/ui/icons";
import { useDeployment } from "@/context/DeploymentContext";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Switch } from "@/components/ui/Switch";
import PublicEndpointsCard from "@/components/routing/PublicEndpointsCard";
import { resolvePublicEndpointHostname } from "@/lib/public-endpoint-payload";

/** Each route is edited on its owning app. The sidebar is a bounded summary. */
export function MonorepoDomains() {
  const { config, updateConfig } = useDeployment();
  const { baseDomain } = usePlatform();
  const { t } = useI18n();
  const copy = t.importProject.monorepo.selection;
  const [editing, setEditing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const apps = (config.monorepoApps ?? []).filter((app) => app.enabled);
  const selected = apps.find((app) => app.id === selectedId) ?? apps[0];
  const endpoints = apps
    .filter((app) => app.exposed !== false)
    .flatMap((app) => app.publicEndpoints.map((endpoint) => ({ app, endpoint })));
  const edit = (id?: string) => {
    setSelectedId(id ?? null);
    setEditing(true);
  };
  if (!apps.length) return null;
  return (
    <div className="min-w-0 rounded-2xl bg-card p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">
          {copy.domains} <span className="ms-1 text-muted-foreground">{endpoints.length}</span>
        </h3>
        <Button variant="ghost" onClick={() => edit()}>
          {copy.manage}
        </Button>
      </div>
      <div className="space-y-2">
        {endpoints.slice(0, 3).map(({ app, endpoint }) => (
          <button
            key={`${app.id}:${endpoint.id}`}
            className="flex w-full items-center gap-3 rounded-xl bg-background p-3 text-start hover:bg-muted/60"
            onClick={() => edit(app.id)}
          >
            <Icon name="globe" className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">
                {resolvePublicEndpointHostname(endpoint, baseDomain) || copy.domainNeeded}
              </span>
              <span className="block truncate text-xs text-muted-foreground">{app.name}</span>
            </span>
            <Icon name="chevron-right" className="size-4 shrink-0 text-muted-foreground" />
          </button>
        ))}
      </div>
      {endpoints.length > 3 && (
        <Button variant="secondary" className="mt-3 w-full" onClick={() => edit()}>
          {interpolate(copy.viewAll, { count: String(endpoints.length) })}
        </Button>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {endpoints.length ? copy.domainHint : copy.privateHint}
      </p>
      {editing && selected && (
        <Modal
          isOpen
          onClose={() => setEditing(false)}
          width="720px"
          maxWidth="calc(100vw - 32px)"
          footer={
            <div className="flex justify-end p-4">
              <Button onClick={() => setEditing(false)}>{copy.done}</Button>
            </div>
          }
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-domains-title"
            onKeyDown={(event) => {
              if (event.key === "Escape") setEditing(false);
            }}
            className="p-5 space-y-4"
          >
            <h2 id="app-domains-title" className="pe-8 text-lg font-semibold">
              {copy.domains}
            </h2>
            <CustomSelect
              aria-label={copy.app}
              variant="filled"
              triggerClassName="bg-muted/60 hover:bg-muted"
              value={selected.id}
              onChange={setSelectedId}
              options={apps.map((app) => ({
                value: app.id,
                label: app.name,
                description: app.rootDirectory,
              }))}
            />
            <div className="flex items-center justify-between gap-4 rounded-xl bg-background p-4">
              <div>
                <p className="text-sm font-medium">{copy.publicAccess}</p>
                <p className="mt-1 text-xs text-muted-foreground">{copy.accessHint}</p>
              </div>
              <Switch
                checked={selected.exposed !== false}
                onChange={(exposed) =>
                  updateConfig({
                    monorepoApps: config.monorepoApps?.map((app) =>
                      app.id === selected.id ? { ...app, exposed } : app,
                    ),
                  })
                }
                ariaLabel={copy.publicAccess}
              />
            </div>
            {selected.exposed !== false && (
              <PublicEndpointsCard
                key={selected.id}
                projectName={selected.name}
                endpoints={selected.publicEndpoints}
                hasServer={selected.hasServer}
                runtimePort={selected.port}
                allowPortEdit={selected.hasServer}
                hideHeader
                onChange={(publicEndpoints, runtimePort) =>
                  updateConfig({
                    monorepoApps: config.monorepoApps?.map((app) =>
                      app.id === selected.id
                        ? {
                            ...app,
                            publicEndpoints,
                            ...(runtimePort !== undefined ? { port: runtimePort } : {}),
                          }
                        : app,
                    ),
                  })
                }
              />
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}
