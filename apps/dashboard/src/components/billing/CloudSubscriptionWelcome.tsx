"use client";

import { useEffect, useId, useState } from "react";
import { BillingLink as Link } from "@/components/billing/BillingWorkspaceContext";
import { PLANS } from "@repo/core";
import { Icon } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { useAuth } from "@/context/AuthContext";
import { usePlatform } from "@/context/PlatformContext";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import type { BillingState } from "@/lib/api/billing";
import { PlanResources } from "./PlanResources";
import { CloudPlanIllustration } from "./CloudPlanIllustration";

function readAcknowledged(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(value)
      ? value.filter((id): id is string => typeof id === "string").slice(-20)
      : [];
  } catch {
    return [];
  }
}

/** Mounted only after the existing checkout verifier confirms payment and access. */
export function CloudSubscriptionWelcome({
  state,
  checkoutId,
}: {
  state: BillingState;
  checkoutId: string;
}) {
  const { selfHosted, deployMode } = usePlatform();
  const { user } = useAuth();
  if (selfHosted || deployMode === "desktop" || !user) return null;
  return (
    <CheckoutWelcome
      key={`${user.id}:${checkoutId}`}
      state={state}
      checkoutId={checkoutId}
      userId={user.id}
    />
  );
}

function CheckoutWelcome({
  state,
  checkoutId,
  userId,
}: {
  state: BillingState;
  checkoutId: string;
  userId: string;
}) {
  const [open, setOpen] = useState(false);
  const storageKey = `openship:subscription-welcome:${userId}`;

  useEffect(() => {
    setOpen(!readAcknowledged(storageKey).includes(checkoutId));
    const onStorage = (event: StorageEvent) => {
      if (event.key === storageKey && readAcknowledged(storageKey).includes(checkoutId))
        setOpen(false);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [checkoutId, storageKey]);

  function dismiss() {
    setOpen(false);
    try {
      const acknowledged = readAcknowledged(storageKey).filter((id) => id !== checkoutId);
      localStorage.setItem(storageKey, JSON.stringify([...acknowledged, checkoutId].slice(-20)));
    } catch {
      // Storage is optional; dismissing must work in restricted browsers too.
    }
  }

  return (
    <Modal isOpen={open} onClose={dismiss} showCloseButton={false} width="100%" maxWidth="520px">
      <WelcomeContent state={state} onClose={dismiss} />
    </Modal>
  );
}

function WelcomeContent({ state, onClose }: { state: BillingState; onClose: () => void }) {
  const { t } = useI18n();
  const copy = t.billing.welcome;
  const titleId = useId();
  const descriptionId = useId();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  const plan = state.plan?.id === state.tier ? state.plan : null;
  const hasNoProjects = state.capacity?.projects?.used === 0;

  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="relative p-6 outline-none sm:p-8"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={copy.dismiss}
        onClick={onClose}
        className="absolute end-4 top-4 z-10"
      >
        <Icon name="close" className="size-4" aria-hidden="true" />
      </Button>
      <CloudPlanIllustration subscribed className="mx-auto mb-4" />
      <div className="text-center">
        <p className="inline-flex rounded-full bg-success/10 px-3 py-1 text-sm font-medium text-success">{copy.eyebrow}</p>
        <h2 id={titleId} className="mt-3 text-2xl font-semibold tracking-tight text-foreground">
          {interpolate(copy.title, { name: plan?.name ?? PLANS[state.tier].name })}
        </h2>
        <p id={descriptionId} className="mx-auto mt-3 max-w-sm text-sm leading-6 text-muted-foreground">
          {copy.description}
        </p>
      </div>
      {plan && (
        <div className="mt-6">
          <PlanResources plan={plan} compact />
        </div>
      )}
      <div className="mt-6 flex flex-col gap-2">
        <Button asChild className="h-11 w-full">
          <Link href={hasNoProjects ? "/library" : "/projects"} onClick={onClose}>
            {hasNoProjects ? t.billing.onboarding.stepDeploy : copy.openProjects}
            <Icon name="arrow-right" className="size-4 rtl:rotate-180" aria-hidden="true" />
          </Link>
        </Button>
        <Button asChild variant="ghost" className="h-10 w-full text-muted-foreground">
          <Link href="/billing/overview" onClick={onClose}>
            {copy.viewPlan}
          </Link>
        </Button>
      </div>
    </div>
  );
}
