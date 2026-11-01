"use client";

import { cloudSpaceHref } from "@/lib/cloud-spaces";
import { observedAllSettled, reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useI18n } from "@/components/i18n-provider";
import { billingApi, type BillingState } from "@/lib/api/billing";
import { systemApi } from "@/lib/api/system";
import { CloudSubscriptionWelcome } from "@/components/billing/CloudSubscriptionWelcome";
import { useBillingWorkspace } from "@/components/billing/BillingWorkspaceContext";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";

interface CheckoutReturn {
  kind: "subscription" | "topup";
  checkoutId?: string;
  expectedTier?: string;
  expectedInterval?: "monthly" | "annual";
  expectedOffer?: string;
}

type ConfirmationStatus =
  | "checking" | "active" | "pending" | "failed" | "reversed"
  | "paidPending" | "paidFailed" | "provisioning" | "setupPending" | "setupFailed";

/** A different return URL must never reuse the previous checkout's confirmation. */
export function BillingCheckoutStatus(props: CheckoutReturn) {
  const workspaceId = useBillingWorkspace();
  const { data: session } = useSession();
  const key = JSON.stringify([
    session?.user.id,
    session?.session.activeOrganizationId,
    workspaceId,
    props.kind,
    props.checkoutId,
    props.expectedTier,
    props.expectedInterval,
    props.expectedOffer,
  ]);
  return <CheckoutConfirmation key={key} {...props} />;
}

/** Payment, paid coverage and server readiness are separate confirmations. */
function CheckoutConfirmation({
  kind,
  checkoutId,
  expectedTier,
  expectedInterval,
  expectedOffer,
}: CheckoutReturn) {
  const router = useRouter();
  const workspaceId = useBillingWorkspace();
  const { t } = useI18n();
  const [status, setStatus] = useState<ConfirmationStatus>("checking");
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<BillingState | null>(null);
  const [setupServerId, setSetupServerId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    setStatus("checking");
    setError(null);
    setConfirmed(null);
    setSetupServerId(null);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const billingDeadline = Date.now() + 30_000;
    let setupDeadline: number | undefined;
    let paymentConfirmed = false;
    let awaitingServer = false;
    function finish(next: ConfirmationStatus) {
      setStatus(next);
      router.refresh();
    }
    async function refresh() {
      try {
        const [stateResult, checkoutResult] = await observedAllSettled([
          billingApi.getBillingState(workspaceId),
          checkoutId ? billingApi.getCheckoutStatus(checkoutId, workspaceId) : null,
        ], "dashboard/app/(dashboard)/billing/_components/BillingCheckoutStatus");
        if (disposed) return;
        setError(null);
        if (checkoutResult.status === "rejected") throw checkoutResult.reason;
        const checkout = checkoutResult.value;
        if (checkout && (checkout.id !== checkoutId || checkout.kind !== kind)) {
          finish("failed");
          return;
        }
        if (
          checkout &&
          ["refunded", "partially_refunded", "disputed", "reversed"].includes(checkout.fulfillmentStatus)
        ) {
          finish("reversed");
          return;
        }
        const completePayment = Boolean(
          checkout &&
          ["paid", "no_payment_required"].includes(checkout.paymentStatus) &&
          checkout.status === "complete",
        );
        paymentConfirmed ||= completePayment;
        if (
          checkout &&
          (checkout.status === "expired" ||
            ["failed", "expired", "superseded"].includes(checkout.fulfillmentStatus))
        ) {
          finish(paymentConfirmed ? "paidFailed" : "failed");
          return;
        }
        // Preserve a confirmed payment even if the entitlement read is down.
        if (stateResult.status === "rejected") throw stateResult.reason;
        const state = stateResult.value;
        const paid =
          completePayment &&
          checkout?.fulfilled &&
          checkout.fulfillmentStatus === "completed";
        // Monthly purchases deliver capacity, not credits. The API verifies the
        // saved subscription against the provider's committed capacity snapshot.
        const delivered = kind === "subscription" && state.subscription?.billingMode === "monthly"
          ? state.compute?.billingMode === "monthly" && state.compute.covered && state.compute.status === "active"
          : (checkout?.creditsGranted ?? 0) > 0;
        awaitingServer = false;
        if (
          paid && delivered &&
          (kind === "topup" ||
            (expectedTier &&
              state.tier === expectedTier &&
              state.status === "active" &&
              (!expectedOffer || state.subscription?.offerReference === expectedOffer) &&
              (!expectedInterval || state.subscription?.interval === expectedInterval)))
        ) {
          const needsServer = kind === "subscription" &&
            (state.subscription?.billingMode === "monthly" || Boolean(state.workspace));
          if (!needsServer) {
            setConfirmed(state);
            finish("active");
            return;
          }
          awaitingServer = true;
          setupDeadline ??= Date.now() + 120_000;
          setStatus("provisioning");
          const workspace = state.workspace;
          const serverId = workspace?.serverId;
          // Allocating a provider ID is not readiness. Read the same scoped
          // server status as its Activity tab, which owns setup logs and retry.
          if (workspace?.id && serverId && (!workspaceId || workspace.id === workspaceId)) {
            setSetupServerId(serverId);
            const server = await systemApi.getServerById(serverId);
            if (disposed) return;
            const managed = server.managed;
            if (server.id === serverId && managed?.id === workspace.id && managed.serverId === serverId) {
              if (managed.operation?.status === "failed" || ["failed", "error"].includes(managed.state)) {
                finish("setupFailed");
                return;
              }
              if (
                ["ready", "running", "active"].includes(managed.state) &&
                (!managed.operation || managed.operation.status === "succeeded")
              ) {
                setConfirmed(state);
                finish("active");
                return;
              }
            } else setSetupServerId(null);
          } else setSetupServerId(null);
        } else {
          setStatus("checking");
          setSetupServerId(null);
        }
      } catch (failure) {
        observeCaughtError(failure, "dashboard/app/(dashboard)/billing/_components/BillingCheckoutStatus");
        // An outage cannot confirm readiness or undo a verified payment.
        if (!disposed) setError(failure instanceof Error ? failure.message : null);
      }
      if (disposed) return;
      if (Date.now() >= (setupDeadline ?? billingDeadline)) {
        finish(awaitingServer ? "setupPending" : paymentConfirmed ? "paidPending" : "pending");
      } else timer = setTimeout(refresh, 3_000);
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [workspaceId, kind, checkoutId, expectedTier, expectedInterval, expectedOffer, router, attempt]);

  const pending = ["pending", "paidPending", "setupPending"].includes(status);
  const needsSupport = pending || ["failed", "paidFailed", "reversed", "setupFailed"].includes(status);
  const showSetup = setupServerId && ["provisioning", "setupPending", "setupFailed"].includes(status);

  return (
    <>
      {kind === "subscription" && status === "active" && confirmed && checkoutId && (
        <CloudSubscriptionWelcome state={confirmed} checkoutId={checkoutId} />
      )}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3 rounded-xl bg-muted/40 p-4 text-sm">
        <div className="min-w-0 flex-1 basis-80">
          <p role="status" aria-live="polite">
            {status === "active" && kind === "topup"
              ? t.billing.checkout.topupComplete
              : t.billing.checkout[status]}
          </p>
          {error && pending && <p role="alert" className="mt-2 break-words text-muted-foreground">{error}</p>}
        </div>
        {(needsSupport || showSetup) && (
          <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">
            {(pending || status === "setupFailed" || status === "paidFailed") && (
              <Button type="button" variant="secondary" size="sm" onClick={() => setAttempt(value => value + 1)}>
                {t.billing.checkout.checkAgain}
              </Button>
            )}
            {showSetup && (
              <Button asChild variant="secondary" size="sm">
                <Link href={cloudSpaceHref(setupServerId!, "activity")}>
                  {t.billing.checkout.viewSetup}
                </Link>
              </Button>
            )}
            {needsSupport && (
              <Button asChild variant="link" size="sm">
                <a href="mailto:support@openship.io">{t.billing.checkout.support}</a>
              </Button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
