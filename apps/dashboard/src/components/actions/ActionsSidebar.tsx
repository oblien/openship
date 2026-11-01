"use client";

import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import type { ActionRunView, ActionWorkflowView } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { usePlatform } from "@/context/PlatformContext";
import { ActionStatus } from "./ActionStatus";

export function ActionsSidebar({
  runnerCount,
  readyRunnerCount,
  workflowCount,
  firstWorkflow,
  latestRun,
  onRunners,
}: {
  runnerCount: number;
  readyRunnerCount: number;
  workflowCount: number;
  firstWorkflow?: ActionWorkflowView;
  latestRun?: ActionRunView;
  onRunners: () => void;
}) {
  const { t, locale } = useI18n();
  const a = t.actions;
  const copy = a.setup;
  const { deployMode, selfHosted } = usePlatform();
  const steps = [
    {
      title: copy.runnerTitle,
      description: selfHosted ? copy.runnerHint : copy.cloudRunnerHint,
      icon: "server" as const,
      done: readyRunnerCount > 0,
      href: runnerCount ? undefined : selfHosted ? "/actions/runners/new" : "/actions/billing",
      onClick: runnerCount ? onRunners : undefined,
    },
    {
      title: copy.workflowTitle,
      description: copy.workflowHint,
      icon: "play-circle" as const,
      done: workflowCount > 0,
      href: firstWorkflow ? `/actions/workflows/${firstWorkflow.id}` : "/actions/new",
    },
    {
      title: copy.runTitle,
      description: copy.runHint,
      icon: "play" as const,
      done: !!latestRun,
      href: firstWorkflow ? `/actions/workflows/${firstWorkflow.id}` : undefined,
    },
  ];
  const current = steps.findIndex((step) => !step.done);
  return (
    <aside className="min-w-0 space-y-4 @min-[980px]/actions-home:sticky @min-[980px]/actions-home:top-6">
      <section className="rounded-2xl bg-card p-5" aria-labelledby="actions-setup-title">
        <h2 id="actions-setup-title" className="text-base font-medium text-foreground">
          {latestRun ? copy.overview : copy.title}
        </h2>
        {latestRun ? (
          <>
            <dl className="mt-5 space-y-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-muted-foreground">{a.workflows}</dt>
                <dd className="font-medium tabular-nums text-foreground">
                  {workflowCount.toLocaleString(locale)}
                </dd>
              </div>
              <div className="flex items-center justify-between gap-3">
                <dt>
                  <button
                    type="button"
                    onClick={onRunners}
                    className="rounded text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    {copy.readyRunners}
                  </button>
                </dt>
                <dd className="font-medium tabular-nums text-foreground">
                  <bdi dir="ltr">
                    {readyRunnerCount.toLocaleString(locale)}{" "}
                    <span className="font-normal text-muted-foreground">
                      / {runnerCount.toLocaleString(locale)}
                    </span>
                  </bdi>
                </dd>
              </div>
            </dl>
            <div className="mt-5 border-t border-border/50 pt-4">
              <p className="text-xs text-muted-foreground">{copy.latestRun}</p>
              <Link
                href={`/actions/runs/${latestRun.id}`}
                className="mt-2 flex items-center justify-between gap-3 rounded-lg py-1 focus-visible:outline-2 focus-visible:outline-ring"
              >
                <span className="min-w-0 truncate text-sm font-medium text-foreground">
                  {latestRun.name}{" "}
                  <span className="text-muted-foreground">#{latestRun.number}</span>
                </span>
                <ActionStatus status={latestRun.status} />
              </Link>
            </div>
          </>
        ) : (
          <ol className="mt-5 space-y-5">
            {steps.map((step, index) => {
              const title = (
                <span className="text-sm font-medium text-foreground">{step.title}</span>
              );
              return (
                <li
                  key={step.title}
                  className="relative flex items-start gap-3"
                  aria-current={index === current ? "step" : undefined}
                >
                  {index < steps.length - 1 && (
                    <span
                      aria-hidden="true"
                      className="absolute start-4 top-9 -bottom-4 w-px bg-border/70"
                    />
                  )}
                  <span
                    aria-hidden="true"
                    className={`relative flex size-8 shrink-0 items-center justify-center rounded-xl ${step.done ? "bg-success/10 text-success" : index === current ? "bg-primary text-primary-foreground" : "bg-muted/60 text-muted-foreground"}`}
                  >
                    <Icon name={step.done ? "check" : step.icon} className="size-4" />
                  </span>
                  <div className="min-w-0 pt-0.5">
                    {step.href ? (
                      <Link
                        href={step.href}
                        className="rounded underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {title}
                      </Link>
                    ) : step.onClick ? (
                      <button
                        type="button"
                        onClick={step.onClick}
                        className="rounded text-start underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                      >
                        {title}
                      </button>
                    ) : (
                      title
                    )}
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {step.description}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
        <a
          href="https://openship.io/docs/guides/actions"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 flex items-center gap-2 rounded-lg border-t border-border/50 pt-4 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <Icon name="book" className="size-4" />
          {copy.guide}
          <Icon name="arrow-up-right" className="ms-auto size-4" />
        </a>
      </section>

      {!selfHosted && (
        <section className="rounded-2xl bg-card p-5">
          <div className="flex items-center gap-2.5">
            <Icon name="cloud" className="size-5 text-muted-foreground" />
            <h2 className="text-sm font-medium text-foreground">{a.cloudRunner}</h2>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{copy.cloudHint}</p>
          <Button asChild variant="secondary" className="mt-4 w-full">
            <Link href="/actions/billing">
              {a.budget.label}
              <Icon name="arrow-right" className="rtl:rotate-180" />
            </Link>
          </Button>
        </section>
      )}

      {deployMode === "desktop" && (
        <section className="rounded-2xl bg-card p-5">
          <div className="flex items-center gap-2.5">
            <Icon name="globe" className="size-4 text-muted-foreground" />
            <h2 className="text-sm font-medium text-foreground">{copy.onlineTitle}</h2>
          </div>
          <p className="mt-3 text-xs leading-relaxed text-muted-foreground">{a.onlineHint}</p>
          <Button asChild size="sm" variant="ghost" className="mt-3 -ms-3">
            <Link href="/settings?tab=instance">
              {a.publish}
              <Icon name="arrow-up-right" />
            </Link>
          </Button>
        </section>
      )}
    </aside>
  );
}
