"use client";

import { Icon as UiIcon } from "@repo/ui/icons";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ActionError, ActionStatus } from "@/components/actions/ActionStatus";
import { useActionResource, useActionScope } from "@/components/actions/useActions";
import type { ActionStatus as WorkflowStatus } from "@repo/core";

import { useCallback } from "react";
import { JobRunOutput } from "./JobRunOutput";
import { jobsApi } from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import { useI18n } from "@/components/i18n-provider";

/** Workflow jobs link to the original execution, including its resumable logs. */
function RunViewer({ runId }: { runId: string }) {
  const { t } = useI18n();
  const fetcher = useCallback(() => jobsApi.getRun(runId), [runId]);
  const polling = useCallback((result: Awaited<ReturnType<typeof jobsApi.getRun>>) => result.data.kind === "workflow" && result.data.status === "running" ? 3000 : 0, []);
  const resource = useActionResource(fetcher, polling);
  const run = resource.data?.data;
  if (!run) return <><ActionError message={resource.error} onRetry={resource.refresh} />{resource.loading && <div className="h-32 animate-pulse rounded-xl bg-muted" />}</>;
  if (run.kind !== "workflow") return <JobRunOutput run={run} path={`jobs/runs/${encodeURIComponent(runId)}/stream`} />;
  return <div className="space-y-4 rounded-xl bg-card p-5">
    <ActionError message={resource.error} onRetry={resource.refresh} />
    <ActionStatus status={run.summary?.status as WorkflowStatus} />
    <p className="text-sm text-muted-foreground">{t.actions.selectJob}</p>
    <Button asChild><Link href={`/actions/runs/${run.id}`}><UiIcon name="git-branch" />{t.actions.integration.viewRun}<UiIcon name="arrow-right" className="rtl:rotate-180" /></Link></Button>
  </div>;
}

export function JobRunLogs({ runId }: { runId: string }) {
  const scope = useActionScope();
  return <RunViewer key={`${scope}:${runId}`} runId={runId} />;
}

/** Modal wrapper for JobRunLogs (used from the list page + detail runs tab). */
export function JobRunLogsModal({ runId, onClose }: { runId: string; onClose: () => void }) {
  const { t } = useI18n();
  const j = t.jobs;
  return (
    <Modal isOpen onClose={onClose} width="760px" maxWidth="94vw" showCloseButton={false}>
      <div className="flex max-h-[80vh] flex-col">
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
          <h2 className="text-[15px] font-semibold text-foreground">{j.logs.title}</h2>
          <button onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted"><UiIcon name="close" className="size-4" /></button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
          <JobRunLogs runId={runId} />
        </div>
      </div>
    </Modal>
  );
}
