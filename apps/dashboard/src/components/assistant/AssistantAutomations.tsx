"use client";
import { useState, type ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import { AssistantListSkeleton } from "./AssistantSkeletons";
import { ASSISTANT_AUTOMATION_TRIGGERS, type AssistantAutomationRun } from "@repo/contracts";
import {
  useScopedResource,
  useScopedMutation,
  useResourceScope,
} from "@/hooks/use-scoped-resource";
import { assistantApi } from "@/lib/api/assistant";
import { assistantAutomationsApi } from "@/lib/api/assistant-automations";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button, buttonVariants } from "@/components/ui/button";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { Tabs } from "@/components/ui/Tabs";
import { cn } from "@/lib/utils";
import { automationFlowSteps, type AutomationFlowSummary } from "./automation-flow";
import {
  AutomationRunReview,
  AutomationRunBadge,
  AutomationResultLink,
} from "./AutomationRunReview";

export function AssistantAutomations() {
  const scope = useResourceScope();
  return (
    <PageContainer fullScreen={false} className="py-5">
      <AutomationWorkspace key={scope} />
    </PageContainer>
  );
}
function AutomationWorkspace() {
  const status = useScopedResource(assistantApi.status);
  if (status.data?.enabled) return <AutomationContent />;
  return (
    <>
      <AutomationHeader />
      <div className="pb-8">
        {status.loading ? <AssistantListSkeleton label="Loading automations" /> : null}
        {!status.loading && !status.error && (
          <div className="mx-auto max-w-2xl py-16 text-center">
            <Icon name="workflow" className="mx-auto mb-5 size-9 text-muted-foreground" />
            <h2 className="text-2xl font-medium">An extra pair of eyes on your apps.</h2>
            <p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-muted-foreground">
              Enable your assistant and connect an agent to investigate failures, review a fix, and
              hear when your app is healthy again.
            </p>
            <Link href="/assistant" className="mt-6 inline-block">
              <Button>
                Set up your assistant <Icon name="arrow-right" className="size-4" />
              </Button>
            </Link>
          </div>
        )}
        {status.error && (
          <p role="alert" className="text-sm text-danger">
            {status.error}
          </p>
        )}
      </div>
    </>
  );
}

function AutomationHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="mb-7 flex items-center justify-between gap-4">
      <div className="flex min-w-0 items-center gap-2.5">
        <Button asChild variant="ghost" size="icon" className="-ms-2 shrink-0">
          <Link href="/assistant" aria-label="Back to assistant">
            <Icon name="arrow-left" className="rtl:rotate-180" />
          </Link>
        </Button>
        <h1 className="text-xl font-medium tracking-tight text-foreground sm:text-2xl">
          Automations
        </h1>
      </div>
      {children}
    </header>
  );
}

function AutomationContent() {
  const overview = useScopedResource(assistantAutomationsApi.overview, 5000);
  const mutation = useScopedMutation();
  const params = useSearchParams();
  const router = useRouter();
  const [tab, setTab] = useState<"flows" | "runs">(params.get("run") ? "runs" : "flows");
  const [review, setReview] = useState<AssistantAutomationRun | null>(null);
  const data = overview.data;
  const waiting = data?.runs.filter((r) => r.state === "approval").length ?? 0;
  return (
    <>
      <AutomationHeader>
        <DropdownMenu
          triggerLabel="Create automation"
          triggerClassName={buttonVariants({ className: "gap-2 px-3 sm:px-4" })}
          trigger={
            <>
              <Icon name="plus" />
              <span className="hidden sm:inline">Create automation</span>
              <span className="sm:hidden">Create</span>
              <Icon name="chevron-down" className="!size-3.5" />
            </>
          }
          actions={ASSISTANT_AUTOMATION_TRIGGERS.map((trigger) => ({
            id: trigger.id,
            label: trigger.label,
            icon: (
              <Icon
                name={trigger.id === "deployment.failed" ? "rocket" : "activity"}
                className="size-4"
              />
            ),
            onClick: () =>
              router.push(`/assistant/automations/new?trigger=${encodeURIComponent(trigger.id)}`),
          }))}
        />
      </AutomationHeader>
      {(overview.error || mutation.error) && (
        <p role="alert" className="mb-5 text-sm text-danger">
          {overview.error ?? mutation.error}
        </p>
      )}
      {data?.paused && (
        <div role="status" className="mb-5 flex items-center gap-3 rounded-2xl bg-card p-4 text-sm">
          <Icon name="pause" className="size-4" />
          All automations are paused. New investigations and pending actions will not run.
        </div>
      )}
      <div className="mb-5 flex items-center justify-between gap-3 border-b border-border/50">
        <Tabs
          tabs={[
            { key: "flows" as const, label: "Flows", count: data?.automations.length },
            { key: "runs" as const, label: "Run history", count: waiting || undefined },
          ]}
          value={tab}
          onChange={setTab}
          idPrefix="automations"
          ariaLabel="Automation lists"
          className="border-b-0"
        />
        <DropdownMenu
          triggerLabel="Automation options"
          disabled={mutation.busy}
          actions={[
            ...(data?.automations.length
              ? [
                  {
                    id: "pause",
                    label: data.paused ? "Resume flows" : "Pause all flows",
                    icon: <Icon name={data.paused ? "play" : "pause"} className="size-4" />,
                    onClick: () =>
                      void mutation.execute(async () => {
                        await assistantAutomationsApi.pause(!data.paused);
                        overview.refresh();
                      }),
                    divider: true,
                  },
                ]
              : []),
            {
              id: "settings",
              label: "Assistant settings",
              icon: <Icon name="settings" className="size-4" />,
              onClick: () => router.push("/settings?tab=assistant"),
            },
          ]}
        />
      </div>
      {overview.loading && !data && <AssistantListSkeleton label="Loading automations" />}
      {data && tab === "flows" && (
        <div role="tabpanel" id="automations-panel-flows" aria-labelledby="automations-tab-flows">
          {!data.automations.length && (
            <div className="mb-6 flex flex-col items-start gap-7 rounded-2xl bg-card p-7 sm:flex-row sm:items-center">
              <svg
                viewBox="0 0 225 130"
                fill="none"
                aria-hidden
                className="w-48 shrink-0 text-muted-foreground"
              >
                <path
                  d="M53 43h61v52h61"
                  stroke="currentColor"
                  strokeOpacity=".2"
                  strokeWidth="2"
                  strokeDasharray="4 5"
                />
                <rect x="12" y="18" width="76" height="52" rx="15" fill="var(--th-sf-04)" />
                <Icon name="activity" x="38" y="33" size="24" />
                <rect x="137" y="70" width="76" height="52" rx="15" fill="var(--th-sf-04)" />
                <Icon name="assistant" x="163" y="84" size="24" />
                <circle cx="114" cy="43" r="4" fill="currentColor" opacity=".4" />
              </svg>
              <div>
                <h3 className="text-lg font-medium">Turn an alert into a next step.</h3>
                <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
                  Your agent can gather the evidence, explain what happened, and help get your app
                  back on track. Choose a trigger from Create automation to get started.
                </p>
              </div>
            </div>
          )}
          <div className="overflow-hidden rounded-2xl bg-card">
            {data.automations.map((flow) => (
              <article key={flow.id} className="border-b border-border/40 last:border-0">
                <Link
                  href={`/assistant/automations/${encodeURIComponent(flow.id)}/edit`}
                  className="group flex items-center gap-4 px-4 py-5 transition-colors hover:bg-muted/40 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-info sm:gap-6 sm:px-6 sm:py-6"
                >
                  <span className="hidden size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60 text-muted-foreground sm:flex">
                    <Icon name="workflow" className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h3 className="line-clamp-2 text-sm font-medium leading-6 text-foreground sm:text-[15px]">
                      {flow.name}
                    </h3>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <span>{flow.projectName}</span>
                      <span aria-hidden>·</span>
                      <span>
                        {flow.mode === "report"
                          ? "Investigate & report"
                          : flow.mode === "approve"
                            ? "Review before fixing"
                            : "Automatic fixes"}
                      </span>
                    </p>
                  </div>
                  <FlowPath flow={flow} />
                  <div className="flex shrink-0 items-center gap-4">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1.5 text-xs",
                        flow.enabled && !data.paused ? "text-info" : "text-muted-foreground",
                      )}
                    >
                      <Icon
                        name={flow.enabled && !data.paused ? "play" : "pause"}
                        className="size-3"
                      />
                      {flow.enabled && !data.paused ? "Enabled" : "Paused"}
                    </span>
                    <Icon
                      name="chevron-right"
                      className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5 rtl:rotate-180"
                    />
                  </div>
                </Link>
              </article>
            ))}
          </div>
        </div>
      )}
      {data && tab === "runs" && (
        <div
          role="tabpanel"
          id="automations-panel-runs"
          aria-labelledby="automations-tab-runs"
          className="space-y-3"
        >
          {!data.runs.length && (
            <div className="rounded-2xl bg-card px-6 py-12 text-center">
              <Icon name="history" className="mx-auto mb-4 size-7 text-muted-foreground" />
              <h3 className="text-base font-medium">The full story, from signal to result.</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Your first investigation will appear here after an enabled flow catches a new
                incident.
              </p>
            </div>
          )}
          {data.runs.map((run) => (
            <article
              id={`run-${run.id}`}
              key={run.id}
              className={`rounded-2xl bg-card p-5 ${params.get("run") === run.id ? "ring-2 ring-foreground/15" : ""}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <h3 className="text-sm font-medium">{run.name}</h3>
                    <AutomationRunBadge run={run} />
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    {run.projectName} · {new Date(run.createdAt).toLocaleString()}
                  </p>
                  <p className="mt-3 text-sm text-muted-foreground">{run.message}</p>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                  <AutomationResultLink run={run} />
                  {run.conversationId && (
                    <Link
                      href={`/assistant?chat=${encodeURIComponent(run.conversationId)}`}
                      className="rounded-xl bg-muted px-3 py-2 text-xs"
                    >
                      View investigation
                    </Link>
                  )}
                  {run.state === "approval" && (
                    <Button size="sm" onClick={() => setReview(run)}>
                      Review action <Icon name="arrow-right" className="size-4" />
                    </Button>
                  )}
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
      <a
        href="https://openship.io/docs/dashboard/assistant#automations"
        className="mt-6 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        How automations work <Icon name="arrow-up-right" className="size-3.5" />
      </a>
      {review && (
        <AutomationRunReview
          run={review}
          onClose={() => setReview(null)}
          onDecided={overview.refresh}
        />
      )}
    </>
  );
}

function FlowPath({ flow }: { flow: AutomationFlowSummary }) {
  const steps = automationFlowSteps(flow);
  return (
    <div
      className="hidden shrink-0 items-center lg:flex"
      role="img"
      aria-label={steps.map((step) => `${step.title}: ${step.summary}`).join(" → ")}
    >
      {steps.map((step, index) => (
        <div key={step.id} className="flex items-center" title={`${step.title}: ${step.summary}`}>
          {index > 0 && <span aria-hidden className="h-px w-3 bg-foreground/15" />}
          <span className={cn("flex size-8 items-center justify-center rounded-lg", step.tone)}>
            <Icon name={step.icon} className="size-3.5" />
          </span>
        </div>
      ))}
    </div>
  );
}
