"use client";

import Link from "next/link";
import type { MigrationRun, TransferProgress } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { DeploymentTerminal } from "@/components/import-project/DeploymentTerminal";
import { InstallStepper, type StepStatus } from "@/components/deploy/InstallStepper";
import { useI18n } from "@/components/i18n-provider";
import { formatBytes } from "@/lib/formatBytes";
import { statusTone } from "./MigrationRunList";

export const importFinished = (status: string) =>
  ["failed", "rolled_back", "succeeded"].includes(status);

export function PlatformImportProgress({
  run,
  progress,
  busy,
  canConfirm,
  onConfirm,
  onStop,
  onRetryStatus,
}: {
  run?: MigrationRun;
  progress: TransferProgress | null;
  busy: boolean;
  canConfirm: boolean;
  onConfirm: () => void;
  onStop: () => void;
  onRetryStatus: () => void;
}) {
  const { t } = useI18n();
  if (!run)
    return (
      <div role="status" className="flex items-center gap-3 rounded-2xl bg-card p-6">
        <Icon name="spinner" className="size-5 animate-spin" />
        Loading import progress…
      </div>
    );
  const tone = statusTone(run.status);
  const ready = run.status === "awaiting_cutover" || run.status === "succeeded";
  const projects = Object.entries(run.importedProjects ?? {});
  const steps: Array<{ id: string; label: string; status: StepStatus }> = [
    {
      id: "import",
      label: "Import services and data",
      status: ready ? "done" : importFinished(run.status) ? "failed" : "active",
    },
    {
      id: "verify",
      label: "Verify apps and move traffic",
      status: run.status === "succeeded" ? "done" : ready ? "active" : "pending",
    },
    {
      id: "complete",
      label: "Complete migration",
      status: run.status === "succeeded" ? "done" : "pending",
    },
  ];
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_310px]">
      <div className="min-w-0 space-y-5">
        <section className="rounded-2xl bg-card p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-semibold">Imported projects</h3>
            <span
              className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs ${tone.bg} ${tone.text}`}
            >
              <Icon name={tone.Icon} className={`size-3.5 ${tone.spin ? "animate-spin" : ""}`} />
              {t.migration.tab.status[run.status]}
            </span>
          </div>
          {run.errorMessage && (
            <p role="alert" className="mt-4 rounded-xl bg-danger-bg p-4 text-sm text-danger">
              {run.errorMessage}
            </p>
          )}
          {progress && (
            <p role="status" className="mt-4 text-sm text-muted-foreground">
              {progress.task} · {formatBytes(progress.movedBytes)} copied
            </p>
          )}
          <div className="mt-4 space-y-2">
            {projects.map(([source, id], index) => (
              <Link
                key={id}
                href={`/projects/${encodeURIComponent(id)}`}
                className="flex items-center gap-3 rounded-xl bg-card p-4 hover:bg-muted"
              >
                <Icon name="project" className="size-5" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">
                  {(
                    run.inputSnapshot?.services as Array<{ id: string; name: string }> | undefined
                  )?.find((s) => s.id === source)?.name ?? `Project ${index + 1}`}
                </span>
                <span className="text-xs text-muted-foreground">Open project</span>
                <Icon name="arrow-up-right" className="size-4" />
              </Link>
            ))}
            {!projects.length && (
              <p className="py-4 text-sm text-muted-foreground">
                Created projects will appear here as the import progresses.
              </p>
            )}
          </div>
          {run.status === "awaiting_cutover" && (
            <div className="mt-6 space-y-4 border-t border-border/50 pt-5">
              <div>
                <h4 className="text-sm font-semibold">Verify before moving traffic</h4>
                <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                  Open each project, check its data, and add a test domain in Domains &amp; Routes.
                  Then move your existing domains and confirm below.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Keep source writers paused until cutover. Retire the old services at the provider
                after verifying the destination.
              </p>
              <Button disabled={busy || !canConfirm} onClick={onConfirm}>
                Confirm cutover complete
                <Icon name="check" className="size-4" />
              </Button>
            </div>
          )}
          {run.status === "succeeded" && (
            <p className="mt-5 text-sm text-muted-foreground">
              Migration complete. Your source resources remain at the provider until you retire
              them.
            </p>
          )}
          {run.status === "failed" && (
            <p className="mt-5 text-sm text-muted-foreground">
              Source data was retained. Review the created projects and copied data before starting
              another import.
            </p>
          )}
        </section>
        {run.deploymentId && (
          <DeploymentTerminal
            deploymentId={run.deploymentId}
            live={!importFinished(run.status) && !ready}
            className="h-80"
          />
        )}
        {run.logs && (
          <details className="rounded-2xl bg-card p-5">
            <summary className="cursor-pointer text-sm font-medium">Import log</summary>
            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
              {run.logs}
            </pre>
          </details>
        )}
      </div>
      <aside className="space-y-5 rounded-2xl bg-card p-5 lg:sticky lg:top-6">
        <h3 className="font-semibold">Migration progress</h3>
        <InstallStepper steps={steps} />
        <p className="text-xs leading-relaxed text-muted-foreground">
          You can leave this page and return to this saved import.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" disabled={busy} onClick={onRetryStatus}>
            <Icon name="refresh" className="size-4" />
            Refresh status
          </Button>
          {!importFinished(run.status) && !ready && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={onStop}>
              Stop import
            </Button>
          )}
        </div>
      </aside>
    </div>
  );
}
