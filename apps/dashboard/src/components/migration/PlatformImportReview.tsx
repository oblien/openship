"use client";

import type { ReactNode } from "react";
import type { PlatformMigrationPlan } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { AppLogo } from "@/components/AppLogo";
import { ServiceIcon } from "@/components/services/ServiceIcon";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { InstallStepper } from "@/components/deploy/InstallStepper";
import { importDataLabel, type ImportChoice } from "./platform-import-model";
import { PlatformImportDomains } from "./PlatformImportDomains";

export function PlatformImportReview({
  sidebarHeader,
  plan,
  choices,
  targetName,
  busy,
  writesPaused,
  workersPaused,
  onWritesPaused,
  onWorkersPaused,
  onEdit,
  onStart,
}: {
  sidebarHeader?: ReactNode;
  plan: PlatformMigrationPlan;
  choices: Record<string, ImportChoice>;
  targetName: string;
  busy: boolean;
  writesPaused: boolean;
  workersPaused: boolean;
  onWritesPaused: (value: boolean) => void;
  onWorkersPaused: (value: boolean) => void;
  onEdit: () => void;
  onStart: () => void;
}) {
  const imports = plan.services.filter((s) => choices[s.id]?.data !== "external");
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-5">
        {plan.warnings.map((warning) => (
          <p key={warning} className="rounded-xl bg-warning-bg p-4 text-sm text-warning">
            {warning}
          </p>
        ))}
        <section className="overflow-hidden rounded-2xl bg-card">
          <div className="flex flex-wrap items-center gap-4 p-5 sm:p-6">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <AppLogo slug={plan.provider} className="size-7 shrink-0" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{plan.projectName}</p>
                <p className="text-xs text-muted-foreground">{plan.environmentName}</p>
              </div>
            </div>
            <Icon name="arrow-right" className="size-5 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <Icon name="server" className="size-6 shrink-0" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {targetName || "Selected destination"}
                </p>
                <p className="text-xs text-muted-foreground">OpenShip</p>
              </div>
            </div>
          </div>
          <div className="border-t border-border/50 px-5 py-2 sm:px-6">
            {plan.services.map((service) => {
              const choice = choices[service.id];
              if (!choice) return null;
              return (
                <div key={service.id} className="flex items-center gap-3 py-4">
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50">
                    <ServiceIcon
                      service={{
                        name: service.name,
                        image: service.image,
                        exposed: service.kind === "app",
                      }}
                      className="size-5"
                    />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{choice.name}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {importDataLabel(service, choice)}
                    </p>
                  </div>
                  <span className="hidden text-xs text-muted-foreground sm:inline">
                    {service.commit
                      ? service.commit.slice(0, 7)
                      : service.external
                        ? "PostgreSQL"
                        : `${service.variables.length} ${service.variables.length === 1 ? "variable" : "variables"}`}
                  </span>
                </div>
              );
            })}
          </div>
        </section>
        <PlatformImportDomains
          services={imports.map((service) => ({
            ...service,
            name: choices[service.id].name,
          }))}
        />
        {(plan.requiresWritePause || plan.requiresWorkerPause) && (
          <section className="space-y-4 rounded-2xl bg-card p-5 sm:p-6">
            <div>
              <h3 className="font-semibold">Before you start</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                {plan.sourceControl === "railway-project"
                  ? "OpenShip will stop the Railway project, copy its persistent volumes, and verify the destination. Source workloads stay stopped until cutover. Keep other deployments paused during the move."
                  : "Pause the source workloads that write data or process jobs. Keep them paused until you finish cutover."}
              </p>
            </div>
            {plan.requiresWritePause && (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-card p-4 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={writesPaused}
                  onCheckedChange={onWritesPaused}
                  disabled={busy}
                />
                <span>
                  {plan.sourceControl === "railway-project"
                    ? "Allow downtime for this project. I have paused other deployments and external jobs that write to it."
                    : "Source writes are paused, including scheduled jobs that change this data."}
                </span>
              </label>
            )}
            {plan.requiresWorkerPause && (
              <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-card p-4 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={workersPaused}
                  onCheckedChange={onWorkersPaused}
                  disabled={busy}
                />
                <span>Source workers are paused so jobs won’t be processed twice.</span>
              </label>
            )}
          </section>
        )}
        {plan.services
          .flatMap((s) => s.warnings.map((message) => ({ id: s.id, name: s.name, message })))
          .map((warning) => (
            <p
              key={`${warning.id}:${warning.message}`}
              className="text-xs leading-relaxed text-muted-foreground"
            >
              <span className="font-medium text-foreground">{warning.name}: </span>
              {warning.message}
            </p>
          ))}
      </div>
      <aside className="space-y-5 rounded-2xl bg-card p-5 lg:sticky lg:top-6">
        {sidebarHeader}
        <section className="space-y-5">
          <div>
            <h3 className="font-semibold">Review complete</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              One project · {imports.length} {imports.length === 1 ? "service" : "services"}
            </p>
          </div>
          <InstallStepper
            steps={[
              { id: "source", label: "Source project discovered", status: "done" },
              { id: "config", label: "Configuration checked", status: "done" },
              { id: "links", label: "Dependency links reviewed", status: "done" },
            ]}
          />
          <Button
            className="w-full"
            disabled={
              busy ||
              !plan.ready ||
              (plan.requiresWritePause && !writesPaused) ||
              (plan.requiresWorkerPause && !workersPaused)
            }
            onClick={onStart}
          >
            <Icon
              name={busy ? "spinner" : "arrow-right"}
              className={`size-4 ${busy ? "animate-spin" : ""}`}
            />
            {busy ? "Starting import…" : "Import project"}
          </Button>
          <Button variant="ghost" className="w-full" disabled={busy} onClick={onEdit}>
            Edit selection
          </Button>
        </section>
        <p className="px-1 text-xs leading-relaxed text-muted-foreground">
          The import creates projects and transfers the selected data. Verify them with a test
          domain before moving production traffic. Source resources stay in place.
        </p>
      </aside>
    </div>
  );
}
