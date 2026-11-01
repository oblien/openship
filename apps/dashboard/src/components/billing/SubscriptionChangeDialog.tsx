"use client";

import { useEffect, useId, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { ServerResizeDetails } from "@/components/servers/managed/ServerResizeDetails";
import { SubscriptionChangeStatus } from "./SubscriptionChangeStatus";
import type { useSubscriptionChange } from "./useSubscriptionChange";

export function SubscriptionChangeDialog({ actions, workspaceId }: { actions: ReturnType<typeof useSubscriptionChange>; workspaceId?: string }) {
  return <Modal isOpen={actions.open} onClose={actions.close} closable={!actions.busy}
    showCloseButton={false} width="100%" maxWidth="640px" maxHeight="calc(100dvh - 2rem)" overflow="hidden" zIndex={10010}>
    <ChangeReview actions={actions} workspaceId={workspaceId} />
  </Modal>;
}

function ChangeReview({ actions, workspaceId }: { actions: ReturnType<typeof useSubscriptionChange>; workspaceId?: string }) {
  const { t, locale } = useI18n();
  const copy = t.billing.planChange;
  const titleId = useId();
  const { dialog, onKeyDown } = useDialogFocus(actions.close);
  useEffect(() => {
    const content = dialog.current;
    if (!content) return;
    // Confirmation and status updates can remove the focused action. Keep
    // keyboard navigation in the dialog when the browser falls back to body.
    const observer = new MutationObserver(() => {
      if (document.activeElement === document.body) content.focus();
    });
    observer.observe(content, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [dialog]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1_000); return () => clearInterval(timer); }, []);
  const quote = actions.quote;
  if (!quote) return null;
  const expired = now >= Date.parse(quote.expiresAt);
  const needsQuote = actions.refreshRequired || (expired && !actions.confirmationStarted);
  const money = (value: number) => new Intl.NumberFormat(locale, { style: "currency", currency: quote.currency.toUpperCase() }).format(value / 100);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(new Date(quote.effectiveAt));
  return <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onKeyDown={onKeyDown}
    className="flex min-h-0 max-h-[calc(100dvh-2rem)] flex-col outline-none">
    <header className="flex shrink-0 items-center justify-between gap-4 px-5 py-3">
      <h2 id={titleId} className="text-lg font-semibold tracking-tight">{copy.title}</h2>
      <Button size="icon" variant="ghost" disabled={actions.busy} aria-label={copy.close} onClick={actions.close}><Icon name="close" className="size-4" /></Button>
    </header>
    <div className="min-h-0 space-y-5 overflow-y-auto px-5 pb-5">
      {actions.change ? <SubscriptionChangeStatus key={actions.change.id} initial={actions.change} workspaceId={workspaceId} /> : <>
        <div className="grid grid-cols-2 gap-3 rounded-xl bg-muted/40 p-4">
          {[{ label: t.billing.pricing.currentPlan, offer: quote.current }, { label: copy.nextPlan, offer: quote.next }].map(({ label, offer }) => <div key={label} className="min-w-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="mt-1 break-words text-base font-semibold">{offer.name}</p>
            <p className="mt-1 text-sm tabular-nums">{money(offer.priceCents)} <span className="text-muted-foreground">{quote.interval === "annual" ? copy.yearly : copy.monthly}</span></p>
          </div>)}
        </div>
        <dl className="space-y-2 text-sm">
          {quote.direction === "upgrade" && <>
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{copy.remainingCharge}</dt><dd className="tabular-nums">{money(quote.remainingTimeCharge)}</dd></div>
            <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{copy.unusedCredit}</dt><dd className="tabular-nums">−{money(quote.unusedTimeCredit)}</dd></div>
          </>}
          <div className="flex justify-between gap-4 pt-1 text-base font-semibold"><dt>{copy.dueNow}</dt><dd className="tabular-nums">{money(quote.amountDueNow)}</dd></div>
          {quote.nextInvoiceAmount !== null && <div className="flex justify-between gap-4"><dt className="text-muted-foreground">{copy.nextInvoice}</dt><dd className="tabular-nums">{money(quote.nextInvoiceAmount)}</dd></div>}
        </dl>
        <p className="text-sm text-muted-foreground">{quote.direction === "downgrade" ? interpolate(copy.nextCycle, { date }) : copy.afterPayment}</p>
        {quote.resize && <ServerResizeDetails preview={quote.resize} notice={quote.direction === "downgrade" ? interpolate(copy.restartNextCycle, { date }) : copy.restartAfterPayment} />}
        <p className="text-xs text-muted-foreground">{copy.preserved}</p>
        {expired && !actions.confirmationStarted && <p role="status" className="text-sm text-warning">{copy.expired}</p>}
      </>}
      {actions.error && <p role="alert" className="text-sm text-danger">{actions.error}</p>}
    </div>
    <footer className="flex shrink-0 justify-end gap-2 px-5 py-3">
      <Button variant="secondary" disabled={actions.busy} onClick={actions.close}>{actions.change ? copy.done : t.servers.detail.cancel}</Button>
      {!actions.change && <Button disabled={actions.busy} onClick={() => void (needsQuote ? actions.refreshQuote() : actions.confirm())}>
        {actions.busy && <Icon name="spinner" className="size-4 animate-spin" />}
        {needsQuote ? copy.refreshQuote : actions.confirmationStarted ? copy.retry : quote.direction === "upgrade" ? copy.confirmUpgrade : copy.confirmDowngrade}
      </Button>}
    </footer>
  </div>;
}
