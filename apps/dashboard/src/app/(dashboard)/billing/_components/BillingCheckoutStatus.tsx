"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/components/i18n-provider";
import { billingApi, type BillingState } from "@/lib/api/billing";
import { CloudSubscriptionWelcome } from "@/components/billing/CloudSubscriptionWelcome";
import { useBillingWorkspace } from "@/components/billing/BillingWorkspaceContext";
import { useSession } from "@/lib/auth-client";

interface CheckoutReturn {
  kind: "subscription" | "topup";
  checkoutId?: string;
  expectedTier?: string;
  expectedInterval?: "monthly" | "annual";
  expectedOffer?: string;
}

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

/** A return URL starts polling; only a fresh provider entitlement confirms access. */
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
  const [status, setStatus] = useState<"checking" | "active" | "pending" | "failed" | "reversed">(
    "checking",
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<BillingState | null>(null);

  useEffect(() => {
    setStatus("checking");
    setError(null);
    setConfirmed(null);
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = Date.now() + 30_000;
    async function refresh() {
      try {
        const [state, checkout] = await Promise.all([
          billingApi.getBillingState(workspaceId),
          checkoutId ? billingApi.getCheckoutStatus(checkoutId, workspaceId) : null,
        ]);
        if (disposed) return;
        setError(null);
        if (
          checkout &&
          ["refunded", "partially_refunded", "disputed"].includes(checkout.fulfillmentStatus)
        ) {
          setStatus("reversed");
          router.refresh();
          return;
        }
        if (
          checkout &&
          (checkout.id !== checkoutId ||
            checkout.kind !== kind ||
            checkout.status === "expired" ||
            ["failed", "expired"].includes(checkout.fulfillmentStatus))
        ) {
          setStatus("failed");
          router.refresh();
          return;
        }
        const paid =
          checkout?.paymentStatus === "paid" &&
          checkout.status === "complete" &&
          checkout.fulfilled &&
          checkout.fulfillmentStatus === "completed" &&
          checkout.creditsGranted > 0;
        if (
          paid &&
          (kind === "topup" ||
            (expectedTier &&
              state.tier === expectedTier &&
              state.status === "active" &&
              (!expectedOffer || state.subscription?.offerReference === expectedOffer) &&
              (!expectedInterval || state.subscription?.interval === expectedInterval)))
        ) {
          setConfirmed(state);
          setStatus("active");
          router.refresh();
          return;
        }
      } catch (failure) {
        // A provider outage does not confirm or undo a payment. Retry briefly.
        if (!disposed) setError(failure instanceof Error ? failure.message : null);
      }
      if (disposed) return;
      if (Date.now() >= deadline) {
        setStatus("pending");
        router.refresh();
      } else timer = setTimeout(refresh, 3_000);
    }
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [workspaceId, kind, checkoutId, expectedTier, expectedInterval, expectedOffer, router]);

  return (
    <>
      {kind === "subscription" && status === "active" && confirmed && checkoutId && (
        <CloudSubscriptionWelcome state={confirmed} checkoutId={checkoutId} />
      )}
      <div role="status" aria-live="polite" className="mb-5 rounded-xl bg-muted/40 p-4 text-sm">
        <p>
          {status === "active" && kind === "topup"
            ? t.billing.checkout.topupComplete
            : t.billing.checkout[status]}
        </p>
        {error && status === "pending" && (
          <p role="alert" className="mt-2">
            {error}
          </p>
        )}
        {["pending", "failed", "reversed"].includes(status) && (
          <a className="mt-2 inline-block underline" href="mailto:support@openship.io">
            {t.billing.checkout.support}
          </a>
        )}
      </div>
    </>
  );
}
