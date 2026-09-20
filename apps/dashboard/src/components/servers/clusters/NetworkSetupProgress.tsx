"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  CheckCircle2,
  ChevronDown,
  Circle,
  CircleAlert,
  Loader2,
  Minus,
  PauseCircle,
} from "lucide-react";
import type { ManagedNetworkSetupLog, ManagedNetworkStepProgress } from "@repo/core";
import { BlurIp } from "@/components/BlurIp";
import { useI18n, interpolate } from "@/components/i18n-provider";

export interface NetworkProgressHost {
  serverId: string;
  name: string;
  address: string;
  steps: ManagedNetworkStepProgress[];
  logs: ManagedNetworkSetupLog[];
}

/** Preserve readable diagnostics while obscuring addresses in demo recordings. */
export function NetworkDiagnosticText({ value }: { value: string }) {
  return (
    <>
      {value
        .split(/((?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?)/g)
        .map((part, i) =>
          /^(?:\d{1,3}\.){3}\d{1,3}/.test(part) ? <BlurIp key={i}>{part}</BlurIp> : part,
        )}
    </>
  );
}

export function NetworkSetupProgress({
  hosts,
  running,
  renderHostActions,
  initiallyCollapsed = false,
  openHost,
}: {
  hosts: NetworkProgressHost[];
  running: boolean;
  renderHostActions?: (host: NetworkProgressHost) => ReactNode;
  initiallyCollapsed?: boolean;
  /** A new request opens the selected server without undoing manual choices on SSE updates. */
  openHost?: { serverId: string } | null;
}) {
  const { t } = useI18n();
  const m = t.servers.networks.managed;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (openHost) setExpanded((old) => ({ ...old, [openHost.serverId]: true }));
  }, [openHost]);
  const scroll = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const entries = hosts
    .flatMap((host) =>
      host.logs.map((log) => ({ ...log, serverId: host.serverId, name: host.name })),
    )
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-1000);
  const lastLog = entries.at(-1);
  useEffect(() => {
    if (follow && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [follow, entries.length, lastLog?.timestamp, lastLog?.message]);
  return (
    <div className="min-w-0 space-y-5">
      {hosts.map((host) => {
        const failed = host.steps.find((step) => step.status === "failed");
        const current = host.steps.find((step) => step.status === "running");
        const stopped = !running && !!current;
        const done = host.steps.filter(
          (step) => step.status === "completed" || step.status === "skipped",
        ).length;
        const complete = host.steps.length > 0 && done === host.steps.length;
        const Icon = failed
          ? CircleAlert
          : running && current
            ? Loader2
            : stopped
              ? PauseCircle
              : complete
                ? CheckCircle2
                : Circle;
        const open =
          expanded[host.serverId] ??
          (!initiallyCollapsed && (hosts.length <= 3 || host.serverId === hosts[0]?.serverId));
        return (
          <section
            key={host.serverId}
            className="min-w-0 rounded-2xl bg-card p-5 sm:p-6"
            aria-label={host.name}
          >
            <div className="flex items-center gap-2">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-start focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                aria-expanded={open}
                aria-controls={`network-steps-${host.serverId}`}
                onClick={() => setExpanded((old) => ({ ...old, [host.serverId]: !open }))}
              >
                <Icon
                  aria-hidden="true"
                  className={`size-5 shrink-0 ${failed ? "text-danger" : complete ? "text-success" : "text-muted-foreground"} ${running && current && !failed ? "animate-spin" : ""}`}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-medium">
                    <span className="break-words">
                      <NetworkDiagnosticText value={host.name} />
                    </span>
                    <span aria-hidden="true" className="h-3 w-px bg-border" />
                    <span
                      className="break-all font-mono text-xs font-normal text-muted-foreground"
                      dir="ltr"
                    >
                      <BlurIp>{host.address}</BlurIp>
                    </span>
                  </span>
                  <span
                    className={`mt-1 block text-xs ${failed ? "text-danger" : "text-muted-foreground"}`}
                    aria-live="polite"
                  >
                    {failed
                      ? m.setupSteps[failed.id]
                      : running && current
                        ? m.setupSteps[current.id]
                        : stopped
                          ? m.stepStatus.interrupted
                          : interpolate(m.completedSteps, {
                              done: String(done),
                              total: String(host.steps.length),
                            })}
                  </span>
                </span>
                <ChevronDown
                  aria-hidden="true"
                  className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
                />
              </button>
              {renderHostActions?.(host)}
            </div>
            {!open && failed?.message && (
              <p className="mt-3 line-clamp-2 break-words whitespace-pre-wrap text-xs leading-relaxed text-danger">
                <NetworkDiagnosticText value={failed.message} />
              </p>
            )}
            {open && (
              <ol id={`network-steps-${host.serverId}`} className="mt-5 space-y-1">
                {host.steps.map((step) => {
                  const effective =
                    step.status === "running" && !running ? "interrupted" : step.status;
                  const StepIcon =
                    effective === "completed"
                      ? CheckCircle2
                      : effective === "failed"
                        ? CircleAlert
                        : effective === "running"
                          ? Loader2
                          : effective === "interrupted"
                            ? PauseCircle
                            : effective === "skipped"
                              ? Minus
                              : Circle;
                  return (
                    <li
                      key={step.id}
                      className={`rounded-xl px-3 py-2.5 ${effective === "running" ? "bg-primary/5" : effective === "failed" ? "bg-danger/5" : ""}`}
                      aria-current={effective === "running" ? "step" : undefined}
                    >
                      <div className="flex items-center gap-2.5">
                        <StepIcon
                          aria-hidden="true"
                          className={`size-4 shrink-0 ${effective === "completed" ? "text-success" : effective === "failed" ? "text-danger" : effective === "running" ? "animate-spin text-primary" : "text-muted-foreground/45"}`}
                        />
                        <span
                          className={`min-w-0 flex-1 text-sm ${effective === "pending" || effective === "skipped" ? "text-muted-foreground" : "text-foreground"}`}
                        >
                          {m.setupSteps[step.id]}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {m.stepStatus[effective]}
                        </span>
                      </div>
                      {step.message && (
                        <p
                          className={`mt-1.5 break-words ps-[26px] text-xs leading-relaxed ${effective === "failed" ? "text-danger" : "text-muted-foreground"}`}
                        >
                          <NetworkDiagnosticText value={step.message} />
                        </p>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        );
      })}
      <section className="relative min-w-0 overflow-hidden rounded-2xl bg-card" aria-label={m.logs}>
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <h2 className="text-sm font-semibold">{m.logs}</h2>
          {running && (
            <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
          )}
        </div>
        <div
          ref={scroll}
          onScroll={() => {
            const el = scroll.current;
            if (el) setFollow(el.scrollHeight - el.clientHeight - el.scrollTop < 80);
          }}
          className="max-h-80 min-h-24 overflow-y-auto bg-muted/20 px-5 py-4"
          role="log"
          aria-live="off"
          tabIndex={0}
        >
          {!entries.length ? (
            <p className="text-xs text-muted-foreground">{m.noLogs}</p>
          ) : (
            <div className="space-y-1 font-mono text-xs">
              {entries.map((log, index) => (
                <div
                  key={`${log.serverId}-${index}`}
                  className={`flex gap-3 ${log.level === "error" ? "text-danger" : log.level === "warn" ? "text-warning" : "text-muted-foreground"}`}
                >
                  <time dateTime={log.timestamp} className="shrink-0 text-muted-foreground/50">
                    {new Date(log.timestamp).toLocaleTimeString([], { hour12: false })}
                  </time>
                  <span className="min-w-0 break-words whitespace-pre-wrap">
                    <span className="text-foreground/65">
                      <NetworkDiagnosticText value={log.name} /> ·{" "}
                    </span>
                    <NetworkDiagnosticText value={log.message} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        {!follow && !!entries.length && (
          <button
            type="button"
            onClick={() => setFollow(true)}
            className="absolute bottom-3 left-1/2 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background"
          >
            <ArrowDown className="size-3.5" />
            {m.jumpLatest}
          </button>
        )}
      </section>
    </div>
  );
}
