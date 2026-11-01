"use client";

import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { BillingLink } from "./BillingWorkspaceContext";

export function CloudActivationSteps() {
  const { t, locale } = useI18n();
  const copy = t.billing.onboarding;
  const steps = [
    { title: copy.stepPlan, description: copy.stepPlanHint },
    { title: copy.stepCheckout, description: copy.stepCheckoutHint },
    { title: copy.stepDeploy, description: copy.stepDeployHint },
  ];
  return (
    <section className="rounded-2xl bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-medium text-foreground">{copy.stepsTitle}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.workspaceDescription}</p>
        </div>
      </div>
      <ol className="mt-5 space-y-4">
        {steps.map((step, index) => (
          <li key={step.title} className="flex items-center gap-3">
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted/60 text-sm font-medium tabular-nums text-muted-foreground"
              aria-hidden="true"
            >
              {(index + 1).toLocaleString(locale)}
            </span>
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-foreground">{step.title}</h3>
              <p className="mt-0.5 text-xs text-muted-foreground">{step.description}</p>
            </div>
          </li>
        ))}
      </ol>
      <Button asChild variant="secondary" className="mt-5">
        <BillingLink href="/billing/plans">{copy.choosePlan}</BillingLink>
      </Button>
    </section>
  );
}
