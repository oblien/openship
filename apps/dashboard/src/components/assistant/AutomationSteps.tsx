"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Icon } from "@repo/ui/icons";
import { cn } from "@/lib/utils";
import {
  AUTOMATION_STEPS,
  automationFlowSteps,
  type AutomationFlowSummary,
} from "./automation-flow";
import { SkeletonBlock } from "./AssistantSkeletons";

type AutomationStepsProps = {
  currentStep?: number | null;
  disabled?: boolean;
  onSelect?(step: number): void;
  children?: ReactNode;
} & ({ flow: AutomationFlowSummary; loading?: boolean } | { flow?: undefined; loading: true });

/** A fixed flow, with one settings row expanded at a time. */
export function AutomationSteps({
  flow,
  currentStep,
  disabled,
  onSelect,
  children,
  loading,
}: AutomationStepsProps) {
  const id = useId();
  const listRef = useRef<HTMLOListElement>(null);
  const steps = flow
    ? automationFlowSteps(flow)
    : AUTOMATION_STEPS.map((step) => ({
        ...step,
        id: step.title.toLowerCase(),
        summary: "",
        detail: undefined,
      }));
  useEffect(() => {
    if (currentStep == null) return;
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-automation-step="${currentStep}"]`)
      ?.focus({ preventScroll: true });
  }, [currentStep]);
  return (
    <ol
      ref={listRef}
      aria-label="Automation steps"
      className="@container overflow-hidden rounded-2xl bg-card"
    >
      {steps.map((step, index) => {
        const expanded = currentStep === index && !!children;
        const content = (
          <>
            <span className="relative z-10 row-span-2 row-start-1 flex size-7 items-center justify-center self-start rounded-full border border-border/60 bg-background text-muted-foreground @md:row-span-1">
              <Icon name={step.icon} className="size-3.5" />
            </span>
            <span
              data-step-title
              className="pt-1 text-xs leading-5 text-muted-foreground @md:text-sm"
            >
              {step.title}
            </span>
            <span className="col-start-2 row-start-2 min-w-0 text-sm leading-5 text-foreground @md:col-start-3 @md:row-start-1 @md:pt-1">
              {loading && !flow ? (
                <SkeletonBlock className="my-1 h-3 w-2/3 max-w-52" />
              ) : (
                <span className="block truncate">{step.summary}</span>
              )}
              {step.detail && (
                <span className="mt-0.5 block text-xs text-muted-foreground">{step.detail}</span>
              )}
            </span>
            {onSelect && (
              <Icon
                name="chevron-down"
                className={cn(
                  "col-start-3 row-span-2 row-start-1 mt-2 size-3.5 self-start text-muted-foreground transition-transform motion-reduce:transition-none @md:col-start-4 @md:row-span-1",
                  expanded && "rotate-180",
                )}
              />
            )}
          </>
        );
        const className = cn(
          "grid min-h-16 w-full grid-cols-[1.75rem_minmax(0,1fr)_1rem] items-start gap-x-3 gap-y-1 px-4 py-4 text-start sm:px-5 @md:grid-cols-[1.75rem_7rem_minmax(0,1fr)_1rem]",
          onSelect &&
            "transition-colors hover:bg-muted/30 focus-visible:bg-muted/60 focus-visible:outline-none focus-visible:[&_[data-step-title]]:text-foreground disabled:cursor-default disabled:hover:bg-transparent",
        );
        return (
          <li key={step.id} className="relative min-w-0" data-automation-stage={index}>
            {index > 0 && (
              <span
                aria-hidden="true"
                data-step-connector="before"
                className="pointer-events-none absolute start-7.5 top-0 z-10 h-4 w-px -translate-x-1/2 bg-border/80 sm:start-8.5 rtl:translate-x-1/2"
              />
            )}
            {index < steps.length - 1 && (
              <span
                aria-hidden="true"
                data-step-connector="after"
                className="pointer-events-none absolute bottom-0 start-7.5 top-11 z-10 w-px -translate-x-1/2 bg-border/80 sm:start-8.5 rtl:translate-x-1/2"
              />
            )}
            {onSelect ? (
              <button
                type="button"
                data-automation-step={index}
                id={`${id}-${index}-toggle`}
                aria-label={`Edit ${step.title} settings`}
                aria-expanded={expanded}
                aria-controls={expanded ? `${id}-${index}-settings` : undefined}
                disabled={disabled || loading}
                onClick={() => onSelect(index)}
                title={step.summary}
                className={className}
              >
                {content}
              </button>
            ) : (
              <div className={className} title={step.summary}>
                {content}
              </div>
            )}
            {expanded && (
              <section
                id={`${id}-${index}-settings`}
                aria-label={`${step.title} settings`}
                className="pb-6 pe-4 ps-14 pt-2 sm:pe-5 sm:ps-15"
              >
                {children}
              </section>
            )}
          </li>
        );
      })}
    </ol>
  );
}
