"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useRef, useState } from "react";
import { jobsApi, getAuthToken } from "@/lib/api";
import { getActiveOrganizationId } from "@/lib/api/client";
import { connectToSSE } from "@/lib/sseClient";
import { Modal } from "@/components/ui/Modal";
import { useI18n } from "@/components/i18n-provider";

type RunStatus = "running" | "success" | "failed";

/** Live + stored log viewer for a job run. Tails the SSE stream; a finished run
 *  emits its stored output as the opening snapshot, so history views work too. */
export function JobRunLogs({ runId }: { runId: string }) {
  const { t } = useI18n();
  const j = t.jobs;
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<RunStatus>("running");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setLines([]);
    setStatus("running");
    let disconnect: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const [token, orgId] = [await getAuthToken(), getActiveOrganizationId()];
      const conn = await connectToSSE(jobsApi.runStreamUrl(runId), {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(orgId ? { "X-Organization-Id": orgId } : {}),
        },
        onMessage: (chunk: string) => {
          for (const raw of chunk.split("\n")) {
            if (!raw.startsWith("data:")) continue;
            try {
              const ev = JSON.parse(raw.slice(5).trim());
              if (ev.type === "log" && typeof ev.line === "string") {
                setLines((prev) => [...prev, ev.line]);
              } else if (ev.type === "snapshot" && ev.run?.output) {
                setLines([ev.run.output]);
                if (ev.run.status === "success" || ev.run.status === "failed") setStatus(ev.run.status);
              } else if (ev.type === "complete") {
                setStatus(ev.status === "success" ? "success" : "failed");
              }
            } catch {
              /* keepalive / non-JSON */
            }
          }
        },
        onError: () => {
          if (!cancelled) setStatus("failed");
        },
      });
      if (cancelled) conn.disconnect();
      else disconnect = conn.disconnect;
    })();
    return () => {
      cancelled = true;
      disconnect?.();
    };
  }, [runId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-2">
        {status === "running" ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-warning"><UiIcon name="spinner" className="size-3.5 animate-spin" />{j.logs.streaming}</span>
        ) : status === "success" ? (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-success"><UiIcon name="check-circle" className="size-3.5" />{j.status.success}</span>
        ) : (
          <span className="inline-flex items-center gap-1.5 text-[12px] text-danger"><UiIcon name="x-circle" className="size-3.5" />{j.status.failed}</span>
        )}
      </div>
      <div className="min-h-[240px] flex-1 overflow-y-auto rounded-xl bg-[#0b0b0c] px-4 py-3 font-mono text-[12px] leading-relaxed text-neutral-200">
        {lines.length === 0 ? (
          <span className="text-neutral-500">{j.logs.empty}</span>
        ) : (
          lines.map((line, i) => <div key={i} className="whitespace-pre-wrap break-all">{line}</div>)
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
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
