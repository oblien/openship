"use client";

import { useCallback, useEffect, useRef } from "react";
import type { MailChangeSelection, MailPlanChangeQuote, MailPlanAllowance, PaidMailPlan } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { useScopedResource } from "@/hooks/use-scoped-resource";
import { managedMailApi } from "@/lib/api/managed-mail";
import { usePlanChangeReview } from "./useSubscriptionChange";
import { SubscriptionChangeDialog } from "./SubscriptionChangeDialog";
import { SubscriptionChangeStatus } from "./SubscriptionChangeStatus";

// Once the provider returns a change, the shared status panel owns polling and payment recovery.
const pollMailChange = (result: Awaited<ReturnType<typeof managedMailApi.changeStatus>>) =>
  result.pending &&
  (!result.change || ["canceled", "failed", "expired"].includes(result.change.status))
    ? 5000
    : 0;

export function useMailPlanChange(target: string | undefined, refreshAccount: () => void) {
  const { t } = useI18n();
  const readStatus = useCallback(
    () =>
      target
        ? managedMailApi.changeStatus(target)
        : Promise.resolve({ change: null, pending: false }),
    [target],
  );
  const status = useScopedResource(readStatus, pollMailChange);
  const refreshStatus = status.refresh;
  const updated = useCallback(() => {
    refreshAccount();
    refreshStatus();
  }, [refreshAccount, refreshStatus]);
  const wasPending = useRef(false);
  useEffect(() => {
    if (!status.data) return;
    if (wasPending.current && !status.data.pending) refreshAccount();
    wasPending.current = status.data.pending;
  }, [status.data, refreshAccount]);
  const actions = usePlanChangeReview<MailPlanChangeQuote>(
    target,
    (quoteId) => managedMailApi.confirmChange(target!, quoteId),
    updated,
  );
  function reviewChange(plan: PaidMailPlan, storageGB?: number, product?: MailChangeSelection["product"]) {
    if (target)
      return actions.review(JSON.stringify([target, plan, storageGB, product]), (idempotencyKey) =>
        managedMailApi.previewChange(target, { plan, storageGB, product, idempotencyKey }),
      );
  }
  const readChange = useCallback(
    async (id: string, cancel: boolean) => {
      if (cancel) return managedMailApi.cancelChange(target!, id);
      const result = await managedMailApi.changeStatus(target!, id);
      if (result.change?.id !== id) throw new Error(t.billing.plansRoute.loadError);
      return result.change;
    },
    [target, t.billing.plansRoute.loadError],
  );
  return {
    actions,
    status,
    updated,
    readChange,
    reviewChange,
    unavailable: status.loading || !!status.error || !!status.data?.pending || actions.busy,
  };
}

export function MailPlanChange({ change }: { change: ReturnType<typeof useMailPlanChange> }) {
  const { t } = useI18n();
  const { status, actions, readChange, updated } = change;
  return (
    <>
      {((actions.error && !actions.open) || status.error) && (
        <p role="alert">
          {actions.error || status.error}{" "}
          {status.error && (
            <Button variant="link" onClick={status.refresh}>
              {t.emails.sidebar.steps.retry}
            </Button>
          )}
        </p>
      )}
      {status.data?.pending &&
        !actions.open &&
        (status.data.change ? (
          <SubscriptionChangeStatus
            key={status.data.change.id}
            appliedText={t.billing.checkout.active}
            initial={status.data.change}
            readChange={readChange}
            onUpdated={updated}
          />
        ) : (
          <p role="status">{t.billing.planChange.processing}</p>
        ))}
      <SubscriptionChangeDialog
        appliedText={t.billing.checkout.active}
        actions={actions}
        readChange={readChange}
        onUpdated={updated}
      >
        {actions.quote?.allowances && (
          <MailAllowanceChanges allowances={actions.quote.allowances} />
        )}
      </SubscriptionChangeDialog>
    </>
  );
}

function MailAllowanceChanges({ allowances }: Pick<MailPlanChangeQuote, "allowances">) {
  const { t, locale } = useI18n();
  const c = t.emails.cloudClient;
  const labels: Record<keyof MailPlanAllowance, string> = {
    domains: c.domainsLabel,
    recipients: c.recipientsLabel,
    storageGB: c.storageLabel,
    mailboxes: c.mailboxesLabel,
  };
  return (
    <table className="w-full text-start text-sm">
      <thead>
        <tr>
          <td />
          <th scope="col" className="text-end font-medium">
            {t.billing.pricing.currentPlan}
          </th>
          <th scope="col" className="text-end font-medium">
            {t.billing.planChange.nextPlan}
          </th>
        </tr>
      </thead>
      <tbody>
        {(Object.keys(labels) as Array<keyof MailPlanAllowance>).map((key) => {
          const before = allowances.current[key],
            after = allowances.next[key];
          if (after === undefined || before === after) return null;
          const format = (value: number) =>
            value.toLocaleString(locale) + (key === "storageGB" ? " GB" : "");
          return (
            <tr key={key}>
              <th scope="row" className="py-1 text-start font-normal text-muted-foreground">
                {labels[key]}
              </th>
              <td className="text-end tabular-nums">{format(before ?? 0)}</td>
              <td className="text-end tabular-nums">{format(after)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
