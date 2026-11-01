"use client";

import Link from "next/link";
import type { CloudWorkspaceSummary } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { ServerResizeDetails } from "./ServerResizeDetails";
import type { ManagedServerActions } from "./useManagedServerActions";
import { workspaceBillingHref } from "@/components/billing/BillingWorkspaceContext";

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
            <Button asChild variant="secondary">
              <Link href={workspaceBillingHref("/billing/overview", server.id)}>
                {t.billing.subscription.manage}
              </Link>
            </Button>
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
          <ServerResizeDetails preview={preview} />
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
