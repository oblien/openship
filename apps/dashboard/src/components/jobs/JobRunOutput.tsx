"use client";

import { useEffect, useRef, useState } from "react";
import { Value } from "@sinclair/typebox/value";
import { JobRunStepSchema, type JobRun, type JobRunStep } from "@repo/contracts";
import { useRunEvents } from "@/hooks/useRunEvents";
import { useI18n } from "@/components/i18n-provider";
import { ActionError, ActionStatus } from "@/components/actions/ActionStatus";
import { LogSnapshotTerminal } from "@/components/import-project/LogSnapshotTerminal";
import { TerminalCardShell } from "@/components/terminal/TerminalCardShell";

const MAX_OUTPUT = 200_000;
/** Jobs and server maintenance share one live/replayed console. A connection
 * failure never changes the persisted execution outcome or sends an apply POST. */
export function JobRunOutput({
  run: initial,
  path,
  onSnapshot,
}: {
  run: JobRun;
  path: string;
  onSnapshot?: (run: JobRun) => void;
}) {
  const { t } = useI18n();
  const [run, setRun] = useState(initial);
  const [logs, setLogs] = useState(initial.output ?? "");
  const saved = useRef(initial);
  const pending = useRef<Array<{ seq: number; line: string }>>([]);
  const publishLogs = () => {
    setLogs(
      ((saved.current.output ?? "") + pending.current.map((e) => e.line + "\n").join("")).slice(
        -MAX_OUTPUT,
      ),
    );
  };
  const stream = useRunEvents<JobRun>(
    initial.status === "running" ? path : null,
    (snapshot) => {
      if (snapshot.id !== initial.id) throw new Error("Progress belongs to another run");
      const seq = Number(snapshot.summary?.logSeq ?? 0);
      pending.current = pending.current.filter((e) => e.seq > seq);
      saved.current = snapshot;
      setRun(snapshot);
      publishLogs();
      onSnapshot?.(snapshot);
    },
    {
      onEvent(event) {
        if (event.type !== "log" || typeof event.line !== "string" || typeof event.seq !== "number")
          return;
        const last = pending.current.at(-1)?.seq ?? Number(saved.current.summary?.logSeq ?? 0);
        if (event.seq <= last) return;
        pending.current.push({ seq: event.seq, line: event.line.slice(-(MAX_OUTPUT - 1)) });
        // Bound transient replay independently of server checkpoint size.
        let bytes = 0;
        pending.current = pending.current
          .slice(-2000)
          .reverse()
          .filter((e) => (bytes += e.line.length + 1) <= MAX_OUTPUT)
          .reverse();
        publishLogs();
      },
    },
  );
  useEffect(() => {
    if (initial.status !== "running") {
      saved.current = initial;
      pending.current = [];
      setRun(initial);
      setLogs(initial.output ?? "");
    }
  }, [initial]);
  const steps = Array.isArray(run.summary?.steps)
    ? run.summary.steps
        .filter((step): step is JobRunStep => Value.Check(JobRunStepSchema, step))
        .map(
          (step): JobRunStep =>
            run.status === "failed"
              ? {
                  ...step,
                  status:
                    step.status === "running"
                      ? "failed"
                      : step.status === "pending"
                        ? "skipped"
                        : step.status,
                }
              : step,
        )
    : [];
  return (
    <div className="space-y-3">
      {!!steps.length && (
        <ol className="space-y-2">
          {steps.map((step) => (
            <li key={step.id} className="flex items-center justify-between gap-3 text-sm">
              <span>{step.label}</span>
              <ActionStatus
                status={
                  step.status === "pending"
                    ? "queued"
                    : step.status === "completed"
                      ? "success"
                      : step.status === "failed"
                        ? "failure"
                        : step.status
                }
              />
            </li>
          ))}
        </ol>
      )}
      <ActionError message={run.error} />
      <ActionError message={stream.error?.message} onRetry={stream.reconnect} />
      <TerminalCardShell
        name={t.jobs.logs.title}
        className="h-[360px] min-h-[360px]"
        status={
          <ActionStatus
            status={
              run.status === "success" ? "success" : run.status === "failed" ? "failure" : "running"
            }
          />
        }
      >
        <LogSnapshotTerminal logs={logs} emptyLabel={t.jobs.logs.empty} />
      </TerminalCardShell>
    </div>
  );
}
