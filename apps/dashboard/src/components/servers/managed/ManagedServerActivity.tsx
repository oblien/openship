"use client";

import type { CloudWorkspaceSummary } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { ServiceStatusIndicator } from "@/components/services/ServiceStatusBadge";
import { Button } from "@/components/ui/button";
import type { ManagedServerActions } from "./useManagedServerActions";

export function ManagedServerActivity({
  server,
  actions,
}: {
  server: CloudWorkspaceSummary;
  actions: ManagedServerActions;
}) {
  const { t, locale } = useI18n();
  const copy = t.billing.workspaces;
  const operation = server.operation;
  const pending = ["queued", "running"].includes(operation?.status ?? "");
  const failed = operation?.status === "failed";
  const completed = operation?.status === "succeeded";

  return (
    <section className="space-y-4 rounded-2xl bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">{copy.operation}</h2>
          {operation && (
            <time dateTime={operation.requestedAt} className="mt-1 block text-xs text-muted-foreground">
              {new Date(operation.requestedAt).toLocaleString(locale)}
            </time>
          )}
        </div>
        {operation && (
          <div className="flex flex-wrap items-center gap-3">
            <span
              role="status"
              className={`inline-flex items-center gap-1.5 text-sm font-medium ${failed ? "text-danger" : completed ? "text-success" : pending ? "text-info" : "text-muted-foreground"}`}
            >
              <ServiceStatusIndicator status={failed ? "failed" : completed ? "running" : pending ? "deploying" : "unknown"} />
              {copy.activity.status[operation.status as keyof typeof copy.activity.status] ?? operation.status}
            </span>
            {failed && (
              <Button size="sm" variant="secondary" disabled={actions.busy} onClick={() => void actions.retry()}>
                {t.billing.plansRoute.tryAgain}
              </Button>
            )}
          </div>
        )}
      </div>
      {operation ? (
        <>
          {operation.error && <p role="alert" className="break-words text-sm text-danger">{operation.error}</p>}
          {pending && operation.nextAttemptAt && (
            <p className="text-xs text-muted-foreground">
              {copy.nextAttempt} {new Date(operation.nextAttemptAt).toLocaleString(locale)}
            </p>
          )}
          {operation.logs.length > 0 ? (
            <pre
              role="log"
              aria-label={t.projectDetail.services.detail.tabs.logs}
              aria-live={pending ? "polite" : "off"}
              tabIndex={0}
              dir="ltr"
              className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded-xl bg-background p-4 text-start text-xs leading-relaxed text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
            >
              {operation.logs.join("\n")}
            </pre>
          ) : (
            <p className="text-sm text-muted-foreground">{pending ? copy.activity.waitingForLogs : copy.activity.noLogs}</p>
          )}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.activity.empty}</p>
      )}
    </section>
  );
}
