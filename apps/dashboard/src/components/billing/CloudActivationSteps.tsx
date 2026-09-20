"use client";

import { useI18n } from "@/components/i18n-provider";

export function CloudActivationSteps() {
  const { t, locale } = useI18n();
  const copy = t.billing.onboarding;
  const steps = [
    { title: copy.stepPlan, description: copy.stepPlanHint },
    { title: copy.stepCheckout, description: copy.stepCheckoutHint },
    { title: copy.stepDeploy, description: copy.stepDeployHint },
  ];
  return <section className="rounded-2xl bg-card p-5 sm:p-6">
    <h2 className="text-base font-semibold text-foreground">{copy.stepsTitle}</h2>
    <ol className="mt-5 grid gap-5 xl:grid-cols-3">
      {steps.map((step, index) => <li key={step.title} className="flex gap-3 xl:flex-col">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted/70 text-xs font-medium tabular-nums text-muted-foreground" aria-hidden="true">{(index + 1).toLocaleString(locale)}</span>
        <div>
          <h3 className="text-sm font-medium text-foreground">{step.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{step.description}</p>
        </div>
      </li>)}
    </ol>
  </section>;
}
