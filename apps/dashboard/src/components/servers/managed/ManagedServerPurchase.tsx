"use client";

import { reportCaughtError } from "@repo/core/diagnostics";
import { useEffect, useRef, useState } from "react";
import type { CloudWorkspaceSummary } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { CloudPlanPicker } from "@/components/billing/CloudPlanPicker";
import { BillingWorkspaceProvider } from "@/components/billing/BillingWorkspaceContext";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/auth-client";
import { systemApi } from "@/lib/api/system";
import { getApiErrorCode, getApiErrorMessage } from "@/lib/api/client";
import { billingApi } from "@/lib/api/billing";
import { useResourceScope } from "@/hooks/use-scoped-resource";
import { randomUUID } from "@/lib/random-uuid";
import { isCloudPurchaseIntent } from "@/lib/cloud-purchase-intent";

interface PurchaseProps {
  /** Marketing supplies a selection; the API supplies its actual terms. */
  initialReferralCode?: string;
  requestedPlanId?: string;
  requestedInterval?: "monthly" | "annual";
  autoCheckout?: boolean;
  checkoutIntent?: string;
  checkoutAttempt?: string;
  preserveProject?: boolean;
  billingEnabled?: boolean;
  onCheckoutStarted?: (server: CloudWorkspaceSummary, checkoutUrl: string) => void | Promise<void>;
  onCancel?: () => void;
}

/** Billing, server setup and destination dialogs share this plan-first purchase.
 * Browsing does not create a server; retries reuse the identity just created. */
export function ManagedServerPurchase(props: PurchaseProps) {
  const { data: session, isPending } = useSession();
  const contextKey = useResourceScope();
  const [intent, setIntent] = useState<{ owner: string; key: string; paymentKey: string; automatic: boolean } | null>(null);
  useEffect(() => {
    if (intent || isPending || !session?.user.id || !session.session.activeOrganizationId) return;
    const url = new URL(window.location.href);
    const saved = props.checkoutIntent ?? url.searchParams.get("checkoutIntent");
    if ((!props.autoCheckout && !saved) || (saved && !isCloudPurchaseIntent(saved))) return;
    const key = saved || randomUUID();
    const attempt = props.checkoutAttempt ?? url.searchParams.get("checkoutAttempt");
    url.searchParams.set("checkoutIntent", key);
    url.searchParams.set("organizationId", session.session.activeOrganizationId);
    window.history.replaceState(window.history.state, "", url);
    setIntent({ owner: contextKey, key, paymentKey: attempt && isCloudPurchaseIntent(attempt) ? attempt : key, automatic: Boolean(props.autoCheckout) });
  }, [props.autoCheckout, props.checkoutIntent, props.checkoutAttempt, intent, isPending, session, contextKey]);
  const owned = intent?.owner === contextKey;
  function settleIntent(removed = false) {
    if (!owned || !intent) return;
    const key = removed ? randomUUID() : intent.key;
    const paymentKey = randomUUID();
    const url = new URL(window.location.href);
    url.searchParams.delete("startCheckout");
    url.searchParams.set("checkoutIntent", key);
    url.searchParams.set("checkoutAttempt", paymentKey);
    window.history.replaceState(window.history.state, "", url);
    setIntent(current => current?.key === intent.key && current.paymentKey === intent.paymentKey
      ? { ...current, key, paymentKey, automatic: false } : current);
  }
  return (
    <BillingWorkspaceProvider>
      <Purchase key={`${contextKey}:${owned ? intent?.key : "manual"}`} {...props} sessionPending={isPending}
        autoCheckout={Boolean(owned && intent?.automatic)} checkoutIntent={owned ? intent?.key : undefined}
        checkoutAttempt={owned ? intent?.paymentKey : undefined} onCheckoutSettled={() => settleIntent()} onIntentRemoved={() => settleIntent(true)} />
    </BillingWorkspaceProvider>
  );
}

function Purchase({
  preserveProject = false,
  billingEnabled = true,
  onCheckoutStarted,
  onCancel,
  sessionPending,
  initialReferralCode,
  requestedPlanId,
  requestedInterval,
  autoCheckout,
  checkoutIntent,
  checkoutAttempt,
  onCheckoutSettled,
  onIntentRemoved,
}: PurchaseProps & { sessionPending?: boolean; onCheckoutSettled?: () => void; onIntentRemoved?: () => void }) {
  const { t } = useI18n();
  const scope = useResourceScope();
  const owner = useRef(scope);
  owner.current = scope;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const created = useRef<CloudWorkspaceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function prepareWorkspace() {
    if (created.current) return created.current.id;
    // Reopening a modal must recover its unpaid space, not buy another one.
    // Recover its saved payment directly, including processing payments.
    const pending = await billingApi.listCheckouts();
    if (!mounted.current || owner.current !== scope) throw new Error("Purchase scope changed");
    const unfinished = pending.items.find(item => item.kind === "subscription");
    if (unfinished) {
      created.current = unfinished.server;
      return { workspaceId: unfinished.server.id, checkoutPending: true as const };
    }
    const storageKey = `openship:cloud-purchase:${scope}`;
    let key = checkoutIntent;
    if (!key) {
      try { key = sessionStorage.getItem(storageKey) ?? undefined; }
      catch (error) { reportCaughtError(error, "dashboard/components/servers/managed/ManagedServerPurchase"); }
      if (!isCloudPurchaseIntent(key)) key = randomUUID();
      try { sessionStorage.setItem(storageKey, key); }
      catch (error) { reportCaughtError(error, "dashboard/components/servers/managed/ManagedServerPurchase"); }
    }
    const create = (idempotencyKey: string) => {
      if (!mounted.current || owner.current !== scope) throw new Error("Purchase scope changed");
      return systemApi.createManagedServer({ name: t.billing.workspaces.defaultName, idempotencyKey });
    };
    let server: CloudWorkspaceSummary;
    try { server = await create(key); }
    catch (error) {
      if (checkoutIntent || getApiErrorCode(error) !== "CLOUD_WORKSPACE_PURCHASE_REMOVED") throw error;
      key = randomUUID();
      try { sessionStorage.setItem(storageKey, key); }
      catch (error) { reportCaughtError(error, "dashboard/components/servers/managed/ManagedServerPurchase"); }
      server = await create(key);
    }
    if (!checkoutIntent && (server.planTierId !== "free" || server.resources)) {
      // The last purchase completed. This explicit Add space is a new purchase.
      key = randomUUID();
      try { sessionStorage.setItem(storageKey, key); }
      catch (error) { reportCaughtError(error, "dashboard/components/servers/managed/ManagedServerPurchase"); }
      server = await create(key);
    }
    created.current = server;
    return created.current.id;
  }

  return (
    <div className="space-y-4">
      <CloudPlanPicker
        currentPlan="free"
        initialReferralCode={initialReferralCode}
        requestedPlanId={requestedPlanId}
        requestedInterval={requestedInterval}
        autoCheckout={autoCheckout}
        checkoutKey={checkoutAttempt}
        onCheckoutSettled={onCheckoutSettled}
        subscription={null}
        billingEnabled={billingEnabled}
        prepareWorkspace={prepareWorkspace}
        onWorkspaceRemoved={id => { if (created.current?.id === id) { created.current = null; onIntentRemoved?.(); } }}
        purchaseDisabled={sessionPending}
        preserveProject={preserveProject}
        onCheckoutStarted={(checkoutUrl) => {
          if (created.current && checkoutUrl && onCheckoutStarted) {
            const server = created.current;
            void Promise.resolve()
              .then(() => onCheckoutStarted(server, checkoutUrl))
              .catch((error) => setError(getApiErrorMessage(error)));
          }
        }}
        purchaseDetails={
          onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t.billing.capacityEditor.cancel}
            </Button>
          )
        }
      />
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
