"use client";

/**
 * InstallStepper — a checklist of named steps with per-step status icons, shared
 * by the guided app-install page (JSON-mapped install phases + per-service
 * sub-lists) and the system-prepare modal (streamed prepare steps). The status
 * union is the SUPERSET of both callers: the install channel adds `active`/
 * `skipped`/`failed`; the prepare stream uses `running`/`error`. Icons and copy
 * are theme tokens only (text-success/danger/primary/muted-foreground) — never
 * hardcoded colors.
 */

import type { ReactNode } from "react";
import { Loader2, CheckCircle2, AlertCircle, Circle, CircleSlash, MinusCircle } from "lucide-react";

export type StepStatus =
  | "pending"
  | "active"
  | "running"
  | "done"
  | "skipped"
  | "failed"
  | "error"
  /** Was in flight when the user stopped the install: settled, but neither done
   *  nor a failure. Carries no danger tone — a cancel is not a fault, and a red
   *  step under "Install cancelled" reads as one. */
  | "stopped";

export interface StepItem {
  id: string;
  label: string;
  status: StepStatus;
  /** Optional detail rendered indented under the row (e.g. a per-service list). */
  children?: ReactNode;
}

function StepIcon({ status }: { status: StepStatus }) {
  if (status === "done") return <CheckCircle2 className="size-3.5 shrink-0 text-success" />;
  if (status === "failed" || status === "error")
    return <AlertCircle className="size-3.5 shrink-0 text-danger" />;
  if (status === "active" || status === "running")
    return <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />;
  if (status === "stopped")
    return <CircleSlash className="size-3.5 shrink-0 text-muted-foreground" />;
  if (status === "skipped")
    return <MinusCircle className="size-3.5 shrink-0 text-muted-foreground/40" />;
  return <Circle className="size-3.5 shrink-0 text-muted-foreground/40" />;
}

function labelClass(status: StepStatus): string {
  if (status === "failed" || status === "error") return "text-danger";
  if (status === "pending" || status === "skipped") return "text-muted-foreground/60";
  // `stopped` sits between the two: it ran, so it isn't dimmed to /60 like a step
  // that never started, but it didn't finish, so it isn't full `text-foreground`.
  if (status === "stopped") return "text-muted-foreground";
  return "text-foreground";
}

export function InstallStepper({ steps }: { steps: StepItem[] }) {
  return (
    <div className="space-y-1">
      {steps.map((s) => (
        <div key={s.id}>
          <div className="flex items-center gap-2 text-[13px]">
            <StepIcon status={s.status} />
            <span className={labelClass(s.status)}>{s.label}</span>
          </div>
          {/* Logical margin, not `ml-`: the indent has to land under the icon
              column, which is on the right in Arabic. */}
          {s.children ? <div className="ms-[22px] mt-1 space-y-1">{s.children}</div> : null}
        </div>
      ))}
    </div>
  );
}
