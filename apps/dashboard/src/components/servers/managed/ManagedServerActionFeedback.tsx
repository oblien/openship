"use client";

import type { CloudWorkspaceSummary } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { CapacitySummary } from "@/components/shared/CapacitySummary";
import type { ManagedServerActions } from "./useManagedServerActions";

/** Action errors and confirmations stay visible whichever server tab is open. */
export function ManagedServerActionFeedback({
  server,
  actions,
  deleting,
  onCancelDelete,
}: {
  server: CloudWorkspaceSummary;
  actions: ManagedServerActions;
  deleting: boolean;
  onCancelDelete: () => void;
}) {
  const { t } = useI18n();
  const copy = t.billing.workspaces;
  const pending = ["queued", "running"].includes(server.operation?.status ?? "");
  const preview = actions.preview;
  const sameSize =
    preview &&
    preview.before.cpuCores === preview.after.cpuCores &&
    preview.before.memoryMb === preview.after.memoryMb &&
    preview.before.diskMb === preview.after.diskMb;

  if (!actions.error && !deleting && !preview) return null;

  return (
    <div className="space-y-4">
      {actions.error && (
        <p role="alert" className="rounded-xl bg-danger/5 p-4 text-sm text-danger">
          {actions.error}
        </p>
      )}
      {deleting && (
        <section className="space-y-4 rounded-2xl bg-card p-5">
          <h2 className="text-base font-medium text-danger">{copy.delete}</h2>
          <p className="text-sm text-muted-foreground">{copy.deleteHint}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              disabled={actions.busy || pending || server.projectCount > 0}
              onClick={() => void actions.remove()}
            >
              {copy.confirmDelete}
            </Button>
            <Button variant="secondary" disabled={actions.busy} onClick={onCancelDelete}>
              {t.servers.detail.cancel}
            </Button>
          </div>
        </section>
      )}
      {preview && (
        <section className="@container/resize space-y-4 rounded-2xl bg-card p-5">
          <h2 className="text-base font-medium">{copy.resizeConfirm}</h2>
          <div className="grid gap-4 @min-[36rem]/resize:grid-cols-2">
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{copy.before}</p>
              <CapacitySummary resources={preview.before} />
            </div>
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{copy.after}</p>
              <CapacitySummary resources={preview.after} />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            {sameSize ? copy.noResize : copy.restartHint}
          </p>
          {!sameSize && preview.restartProjects.length > 0 && (
            <ul className="flex flex-wrap gap-2">
              {preview.restartProjects.map((project) => (
                <li key={project.id} className="rounded-lg bg-muted/50 px-3 py-1.5 text-sm">
                  {project.name}
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap gap-2">
            {!sameSize && (
              <Button disabled={actions.busy || pending} onClick={() => void actions.resize()}>
                {copy.confirmResize}
              </Button>
            )}
            <Button variant="secondary" disabled={actions.busy} onClick={actions.closePreview}>
              {t.servers.detail.cancel}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
