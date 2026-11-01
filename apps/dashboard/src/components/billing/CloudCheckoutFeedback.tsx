"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { CloudSupportCustomerInput } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { CapacitySummary } from "@/components/shared/CapacitySummary";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { usePlatform } from "@/context/PlatformContext";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { createCloudSupportApi } from "@/lib/api/cloud-support";
import { supportTicketHref } from "@/components/support/support-shared";
import { useSession } from "@/lib/auth-client";
import type { CheckoutFailure } from "@/lib/checkout-failure";
import { CloudPlanIllustration } from "./CloudPlanIllustration";
import { planCapacity } from "./plan-presentation";
import type { ApiPlan } from "./PricingCards";

/** Both plan entry points keep the original checkout attempt available for retry. */
export function CloudCheckoutFeedback({ failure, plans, onClose, onRetry }: {
  failure: CheckoutFailure | null;
  plans?: ApiPlan[];
  onClose: () => void;
  onRetry: (failure: CheckoutFailure) => void;
}) {
  const { data: session } = useSession();
  if (!failure) return null;
  return (
    <Modal isOpen onClose={onClose} showCloseButton={false} width="100%" maxWidth="480px" zIndex={11000}>
      <FeedbackContent key={`${session?.user.id}:${failure.workspaceId}:${failure.requestId}`} failure={failure}
        plan={plans?.find(plan => plan.id === failure.planTierId)} onClose={onClose} onRetry={onRetry} />
    </Modal>
  );
}

function FeedbackContent({ failure, plan, onClose, onRetry }: {
  failure: CheckoutFailure;
  plan?: ApiPlan;
  onClose: () => void;
  onRetry: (failure: CheckoutFailure) => void;
}) {
  const { t } = useI18n();
  const copy = t.billing.checkoutUnavailable;
  const { selfHosted } = usePlatform();
  const { data: session } = useSession();
  const titleId = useId();
  const descriptionId = useId();
  const emailId = useId();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  const email = session?.user.email ?? "";
  const [sending, setSending] = useState(false);
  const [receivedEmail, setReceivedEmail] = useState<string | null>(null);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const capacity = plan ? planCapacity(plan) : null;
  const resources = failure.custom?.resources ?? (capacity ? {
    cpuCores: capacity.cpu, memoryMb: capacity.memoryGb * 1024, diskGb: capacity.diskGb,
  } : null);
  const planName = failure.custom ? t.billing.custom.name : plan?.name;
  // Stable, non-sensitive context lets support intake deduplicate an uncertain response.
  // A catalog refresh or locale switch must not change a retried ticket's content.
  const [request] = useState<CloudSupportCustomerInput>(() => ({
    requestId: failure.requestId,
    category: "billing",
    subject: failure.kind === "capacity" ? "Cloud capacity availability" : "Cloud checkout availability",
    message: [
      "Please email me with an update when I can complete this server purchase.",
      `Issue: ${failure.kind}`,
      `Plan: ${failure.custom ? "custom" : failure.planTierId}`,
      `Billing interval: ${failure.interval}`,
      ...(failure.workspaceId ? [`Server reference: ${failure.workspaceId}`] : []),
      ...(resources ? [`Requested resources: ${resources.cpuCores} vCPU, ${resources.memoryMb} MB RAM, ${resources.diskGb} GB storage`] : []),
    ].join("\n"),
  }));

  async function notify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || receivedEmail || !session?.user || selfHosted) return;
    busy.current = true;
    setSending(true);
    setError(false);
    const contact = email.trim().toLowerCase();
    try {
      const receipt = await createCloudSupportApi(session.user.id).create(request);
      if (mounted.current) { setReceivedEmail(contact); setTicketId(receipt.id); }
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "dashboard/components/billing/CloudCheckoutFeedback");
      if (mounted.current) setError(true);
    } finally {
      busy.current = false;
      if (mounted.current) setSending(false);
    }
  }

  return (
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}
      aria-describedby={descriptionId} tabIndex={-1} onKeyDown={onKeyDown}
      className="relative p-6 outline-none sm:p-7">
      <Button type="button" variant="ghost" size="icon" aria-label={copy.close} onClick={onClose}
        className="absolute end-3 top-3 z-10">
        <Icon name="close" className="size-4" aria-hidden="true" />
      </Button>
      <CloudPlanIllustration subscribed={Boolean(receivedEmail)} className="mx-auto mb-4 w-40" />
      <div className="text-center">
        <h2 id={titleId} className="text-xl font-semibold tracking-tight text-foreground">
          {receivedEmail ? copy.receivedTitle : failure.kind === "capacity" ? copy.capacityTitle : copy.checkoutTitle}
        </h2>
        <p id={descriptionId} className="mt-2 text-sm leading-6 text-muted-foreground">
          {receivedEmail ? interpolate(copy.receivedDescription, { email: receivedEmail })
            : failure.kind === "capacity" ? copy.capacityDescription : copy.checkoutDescription}
        </p>
      </div>
      {!receivedEmail && (
        <>
          {(planName || resources) && (
            <div className="mt-5 space-y-2">
              {planName && <p className="text-sm font-medium text-foreground">{planName}</p>}
              {resources && <CapacitySummary resources={{ ...resources, diskMb: resources.diskGb * 1024 }} />}
            </div>
          )}
          {selfHosted ? (
            <Button asChild className="mt-5 w-full">
              <a href={`mailto:support@openship.io?subject=${encodeURIComponent(request.subject)}&body=${encodeURIComponent(request.message)}`}>
                {t.billing.checkout.support}
              </a>
            </Button>
          ) : <form onSubmit={notify} className="mt-5 space-y-3" aria-busy={sending}>
            <div className="space-y-2">
              <label htmlFor={emailId} className="text-sm font-medium text-foreground">{copy.emailLabel}</label>
              <Input id={emailId} variant="filled" type="email" autoComplete="email" required maxLength={254}
                value={email} readOnly disabled={sending} dir="ltr" />
              <p className="text-xs leading-5 text-muted-foreground">{copy.notificationHint}</p>
            </div>
            {error && <p role="alert" className="text-sm text-danger">{copy.requestFailed}</p>}
            <Button type="submit" disabled={sending || !email} className="w-full">
              {sending && <Icon name="spinner" className="size-4 animate-spin" aria-hidden="true" />}
              {sending ? copy.notifying : copy.notify}
            </Button>
          </form>}
        </>
      )}
      {receivedEmail && <Button type="button" onClick={onClose} className="mt-5 w-full">{copy.done}</Button>}
      {ticketId && <Button asChild variant="secondary" className="mt-2 w-full">
        <a href={supportTicketHref(ticketId)} target="_blank" rel="noreferrer">{t.support.viewTicket}</a>
      </Button>}
      <Button type="button" variant="ghost" onClick={() => onRetry(failure)} disabled={sending}
        className="mt-2 w-full text-muted-foreground">{copy.retry}</Button>
    </div>
  );
}
