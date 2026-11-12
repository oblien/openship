"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import type {
  PlatformDiscovery,
  PlatformImportService,
  PlatformMigrationPlan,
} from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { ServiceIcon } from "@/components/services/ServiceIcon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Input } from "@/components/ui/input";
import ServerSelector from "@/components/shared/ServerSelector";
import { formatBytes } from "@/lib/formatBytes";
import {
  importDataLabel,
  missingImportVariables,
  type ImportChoice,
} from "./platform-import-model";

export function PlatformImportServices({
  sidebarHeader,
  discovery,
  choices,
  plan,
  busy,
  targetId,
  targetReady,
  onChoose,
  onTarget,
  onTargetReady,
  onReview,
}: {
  sidebarHeader?: ReactNode;
  discovery: PlatformDiscovery;
  choices: Record<string, ImportChoice>;
  plan?: PlatformMigrationPlan;
  busy: boolean;
  targetId: string;
  targetReady: boolean;
  onChoose: (id: string, patch: Partial<ImportChoice>) => void;
  onTarget: (id: string, name: string) => void;
  onTargetReady: (ready: boolean) => void;
  onReview: () => void;
}) {
  const [query, setQuery] = useState("");
  const selected = discovery.services.filter((s) => choices[s.id]?.selected);
  const imports = selected.filter((s) => choices[s.id].data !== "external");
  const missing = selected.reduce(
    (count, s) => count + missingImportVariables(s, choices[s.id]).length,
    0,
  );
  const copies = selected.filter((s) => choices[s.id].data === "copy");
  const visible = discovery.services.filter((s) =>
    `${s.name} ${s.image ?? ""} ${s.repository ?? ""}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-2">
          <div>
            <h3 className="font-semibold">
              {discovery.provider === "railway" ? "Review the project" : "Choose what to bring"}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {discovery.projectName} · {discovery.environmentName}
            </p>
          </div>
          <span className="text-xs text-muted-foreground">
            {selected.length} of {discovery.services.length} selected
          </span>
        </div>
        {discovery.services.length > 5 && (
          <Input
            variant="filled"
            aria-label="Search services"
            placeholder="Find a service…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        )}
        {discovery.warnings.map((warning) => (
          <p key={warning} className="rounded-xl bg-warning-bg p-4 text-sm text-warning">
            {warning}
          </p>
        ))}
        {plan && !plan.ready && (
          <p role="alert" className="rounded-xl bg-warning-bg p-4 text-sm text-warning">
            Some services need attention. Review the highlighted items, then check the import again.
          </p>
        )}
        {visible.map(
          (service) =>
            choices[service.id] && (
              <ImportServiceCard
                key={service.id}
                service={service}
                choice={choices[service.id]}
                reviewed={plan?.services.find((s) => s.id === service.id)}
                busy={busy}
                wholeProject={discovery.provider === "railway"}
                onChange={(patch) => onChoose(service.id, patch)}
              />
            ),
        )}
        {!visible.length && (
          <p className="py-6 text-center text-sm text-muted-foreground">
            No services match “{query}”.
          </p>
        )}
      </div>
      <aside className="space-y-5 rounded-2xl bg-card p-5 lg:sticky lg:top-6">
        {sidebarHeader}
        <div className="space-y-5">
          <h3 className="font-semibold">Import destination</h3>
          <ServerSelector
            forDeployment
            value={targetId}
            onSelect={(server) => onTarget(server?.id ?? "", server?.name ?? "")}
            onReadyChange={onTargetReady}
            disabled={busy}
            label="Plan or server"
            useSavedDefault={false}
          />
          <dl className="space-y-3 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">New projects</dt>
              <dd>{imports.length}</dd>
            </div>
            <div className="flex items-center justify-between">
              <dt className="text-muted-foreground">Data transfers</dt>
              <dd>{copies.length}</dd>
            </div>
            {selected.length > imports.length && (
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">Keep external</dt>
                <dd>{selected.length - imports.length}</dd>
              </div>
            )}
          </dl>
          {missing > 0 && (
            <p className="flex items-start gap-2 text-xs text-warning">
              <Icon name="key" className="mt-0.5 size-4 shrink-0" />
              {missing} secret {missing === 1 ? "value needs" : "values need"} to be entered before
              review.
            </p>
          )}
          <Button
            className="w-full"
            disabled={busy || !targetReady || !targetId || !imports.length || missing > 0}
            onClick={onReview}
          >
            {busy ? (
              <Icon name="spinner" className="size-4 animate-spin" />
            ) : (
              <Icon name="check-circle" className="size-4" />
            )}
            {busy ? "Checking import…" : "Check import"}
          </Button>
          <p className="text-xs leading-relaxed text-muted-foreground">
            Checks repository access, settings and dependency links. Nothing deploys until you
            confirm the review.
          </p>
        </div>
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          Each selected service becomes a project. Configure test domains after import, then move
          production traffic.
        </p>
      </aside>
    </div>
  );
}

function ImportServiceCard({
  service,
  choice,
  reviewed,
  busy,
  wholeProject = false,
  onChange,
}: {
  service: PlatformImportService;
  choice: ImportChoice;
  reviewed?: PlatformImportService;
  busy: boolean;
  wholeProject?: boolean;
  onChange: (patch: Partial<ImportChoice>) => void;
}) {
  const regionId = useId();
  const missing = missingImportVariables(service, choice);
  const blockers = reviewed?.blockers ?? service.blockers;
  const [open, setOpen] = useState(missing.length > 0);
  useEffect(() => {
    if (reviewed?.blockers.length) setOpen(true);
  }, [reviewed]);
  const setEnvironment = (key: string, value: string | null | undefined) => {
    const env = { ...choice.env };
    if (value === undefined) delete env[key];
    else env[key] = value;
    onChange({ env });
  };
  return (
    <section
      className={`overflow-hidden rounded-2xl bg-card ${choice.selected && blockers.length ? "ring-1 ring-warning/40" : ""}`}
    >
      <div className="flex items-center gap-3 p-4 sm:p-5">
        {!wholeProject && (
          <Checkbox
            checked={choice.selected}
            disabled={busy}
            aria-label={`Import ${service.name}`}
            onCheckedChange={(selected) => onChange({ selected })}
          />
        )}
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50">
          <ServiceIcon
            service={{ name: service.name, image: service.image, exposed: service.kind === "app" }}
            className="size-6"
          />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-semibold">{service.name}</h3>
          <p className="mt-1 truncate text-xs text-muted-foreground">
            {service.repository ?? service.image ?? "External PostgreSQL"}
          </p>
          <p
            className={`mt-1.5 text-xs ${missing.length && choice.selected ? "text-warning" : "text-muted-foreground"}`}
          >
            {!choice.selected
              ? "Not selected"
              : missing.length
                ? `${missing.length} ${missing.length === 1 ? "secret needed" : "secrets needed"}`
                : importDataLabel(service, choice)}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !choice.selected}
          aria-expanded={open && choice.selected}
          aria-controls={regionId}
          aria-label={`Configure ${service.name}`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="hidden sm:inline">Configure</span>
          <Icon name={open && choice.selected ? "chevron-up" : "chevron-down"} className="size-4" />
        </Button>
      </div>
      {open && choice.selected && (
        <div id={regionId} className="space-y-5 border-t border-border/50 p-4 sm:p-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-xs font-medium">
              Project name
              <Input
                variant="filled"
                className="mt-2"
                value={choice.name}
                disabled={busy}
                onChange={(e) => onChange({ name: e.target.value })}
              />
            </label>
            {(service.kind === "database" || service.volumes.length > 0) && (
              <div>
                <label className="mb-2 block text-xs font-medium" htmlFor={`${regionId}-data`}>
                  Data
                </label>
                <CustomSelect
                  id={`${regionId}-data`}
                  variant="filled"
                  triggerClassName="bg-muted/60 hover:bg-muted"
                  value={choice.data}
                  disabled={busy}
                  options={[
                    ...(service.external
                      ? [{ value: "external", label: "Keep at current provider" }]
                      : []),
                    {
                      value: "copy",
                      label: service.kind === "database" ? "Copy database" : "Copy files",
                    },
                    { value: "empty", label: "Start with empty storage" },
                  ]}
                  onChange={(data) => onChange({ data: data as ImportChoice["data"] })}
                />
              </div>
            )}
          </div>
          {choice.data === "empty" &&
            (service.kind === "database" || service.volumes.length > 0) && (
              <p className="rounded-xl bg-warning-bg p-3 text-xs text-warning">
                The destination starts empty. Source data will not be copied.
              </p>
            )}
          {service.external && choice.data !== "external" && (
            <label className="block text-xs font-medium">
              Source PostgreSQL major version
              <Input
                variant="filled"
                className="mt-2 sm:max-w-48"
                inputMode="numeric"
                placeholder="For example, 17"
                value={choice.databaseVersion ?? ""}
                disabled={busy}
                onChange={(e) => onChange({ databaseVersion: e.target.value })}
              />
            </label>
          )}
          {service.commit && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Icon name="github" className="size-4" />
              {service.branch ?? "Deployed revision"} · <code>{service.commit.slice(0, 12)}</code>
            </p>
          )}
          {service.volumes.length > 0 && (
            <div className="space-y-2">
              {service.volumes.map((volume) => (
                <div
                  className="flex items-center gap-2 text-xs text-muted-foreground"
                  key={volume.id}
                >
                  <Icon name="hard-drive" className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 break-all font-mono">{volume.mountPath}</span>
                  {volume.sizeBytes != null && (
                    <span className="shrink-0">{formatBytes(volume.sizeBytes)}</span>
                  )}
                </div>
              ))}
            </div>
          )}
          {service.variables.length > 0 && (
            <details className="rounded-xl bg-card p-4" open={missing.length > 0 || undefined}>
              <summary className="cursor-pointer text-sm font-medium">
                Environment{" "}
                <span className="ms-1 font-normal text-muted-foreground">
                  {service.variables.length} variables
                </span>
              </summary>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Existing values transfer securely. Fill in missing secrets or override a value for
                OpenShip.
              </p>
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                {service.variables.map((variable) => (
                  <div key={variable.key} className="min-w-0">
                    <div className="mb-2 flex items-start gap-2">
                      <Checkbox
                        size="sm"
                        checked={choice.env?.[variable.key] !== null}
                        disabled={busy || variable.required}
                        aria-label={`Include ${variable.key}`}
                        onCheckedChange={(include) =>
                          setEnvironment(variable.key, include ? undefined : null)
                        }
                      />
                      <label
                        htmlFor={`${regionId}-${variable.key}`}
                        className="min-w-0 break-all text-xs"
                      >
                        {variable.key}
                        {variable.required && (
                          <span
                            className={`ms-1 ${missing.includes(variable.key) ? "text-warning" : "text-muted-foreground"}`}
                          >
                            {missing.includes(variable.key) ? "Required" : "Provided"}
                          </span>
                        )}
                      </label>
                    </div>
                    <Input
                      id={`${regionId}-${variable.key}`}
                      variant="filled"
                      className="font-mono text-xs"
                      type="password"
                      autoComplete="new-password"
                      value={choice.env?.[variable.key] ?? ""}
                      disabled={busy || choice.env?.[variable.key] === null}
                      onChange={(e) => setEnvironment(variable.key, e.target.value || undefined)}
                      placeholder={
                        choice.env?.[variable.key] === null
                          ? "Excluded"
                          : variable.required
                            ? "Enter secret value"
                            : "Use source value"
                      }
                    />
                  </div>
                ))}
              </div>
            </details>
          )}
          {service.domains.length > 0 && (
            <div className="space-y-2 text-xs">
              <p className="font-medium">Domains · configure after import</p>
              {service.domains.map((domain) => (
                <p
                  className="flex flex-wrap items-center gap-2 text-muted-foreground"
                  key={domain.hostname}
                >
                  <Icon name="globe" className="size-3.5" />
                  <span className="break-all">{domain.hostname}</span>
                  {!domain.portable && <span>Provider-owned</span>}
                </p>
              ))}
            </div>
          )}
          {(reviewed?.warnings ?? service.warnings).map((warning) => (
            <p key={warning} className="text-xs leading-relaxed text-muted-foreground">
              {warning}
            </p>
          ))}
          {blockers.map((blocker) => (
            <p role="alert" key={blocker} className="text-sm text-warning">
              {blocker}
            </p>
          ))}
        </div>
      )}
      {!open && choice.selected && blockers.length > 0 && (
        <p className="px-5 pb-4 text-xs text-warning">
          {blockers.length} {blockers.length === 1 ? "item needs" : "items need"} review. Open
          Configure to resolve.
        </p>
      )}
    </section>
  );
}
