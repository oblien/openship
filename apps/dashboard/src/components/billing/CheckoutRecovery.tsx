"use client";

import { cloudSpaceHref } from "@/lib/cloud-spaces";
import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { BillingCheckoutActionResult, BillingPendingCheckout } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { billingApi } from "@/lib/api/billing";
import { getApiErrorCode, getApiErrorMessage } from "@/lib/api/client";
import { useSession } from "@/lib/auth-client";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { scopedBillingHref } from "@/lib/billing-links";
import { beginCheckoutNavigation } from "@/lib/checkout-navigation";
import { ManagedServerActionFeedback } from "@/components/servers/managed/ManagedServerActionFeedback";
import { useManagedServerActions } from "@/components/servers/managed/useManagedServerActions";
import { useBillingScope } from "./BillingWorkspaceContext";
import { PendingCheckoutsProvider, usePendingCheckouts } from "./PendingCheckoutsContext";

interface RecoveryProps {
  workspaceId?: string;
  preserveProject?: boolean;
  onCleared?: () => void;
  onCheckoutStarted?: (url: string) => void;
  onServerRemoved?: (workspaceId: string) => void;
  onChoosePlan?: () => void;
}

export function CheckoutRecoveryDialog({
  isOpen,
  onClose,
  ...props
}: RecoveryProps & {
  isOpen: boolean;
  onClose: () => void;
}) {
  if (!isOpen) return null;
  return (
    <Modal
      isOpen
      onClose={onClose}
      showCloseButton={false}
      width="100%"
      maxWidth="620px"
      zIndex={11000}
    >
      <RecoveryDialogContent {...props} onClose={onClose} />
    </Modal>
  );
}

function RecoveryDialogContent({ onClose, ...props }: RecoveryProps & { onClose: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  return (
    <div
      ref={dialog}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="relative p-5 outline-none sm:p-6"
    >
      <Button
        variant="ghost"
        size="icon"
        className="absolute end-3 top-3"
        onClick={onClose}
        aria-label={t.billing.checkoutUnavailable.close}
      >
        <Icon name="close" className="size-4" aria-hidden="true" />
      </Button>
      <PendingCheckoutsPanel {...props} titleId={titleId} onChoosePlan={onClose} />
    </div>
  );
}

/** Key every request and action to the current customer, not just the server. */
export function PendingCheckoutsPanel(props: RecoveryProps & { titleId?: string }) {
  const { data: session, isPending } = useSession();
  const cloudKey = useCloudResourceKey();
  const { organizationId } = useBillingScope();
  const shared = usePendingCheckouts();
  if (isPending || (organizationId && organizationId !== session?.session.activeOrganizationId))
    return null;
  const owner = `${cloudKey}:${session?.user.id ?? "local"}:${session?.session.activeOrganizationId ?? ""}`;
  if (shared && shared.workspaceId === props.workspaceId)
    return <CheckoutList key={`${owner}:${props.workspaceId ?? "all"}`} {...props} />;
  return (
    <PendingCheckoutsProvider workspaceId={props.workspaceId}>
      <CheckoutList {...props} />
    </PendingCheckoutsProvider>
  );
}

function CheckoutList({ titleId, ...props }: RecoveryProps & { titleId?: string }) {
  const { t } = useI18n();
  const copy = t.billing.pendingPayments;
  const checkouts = usePendingCheckouts()!;
  const { items, count, loading, error, refresh, markCleared } = checkouts;
  const onCleared = useRef(props.onCleared);
  onCleared.current = props.onCleared;
  useEffect(() => {
    if (!loading && !error && items.length === 0) onCleared.current?.();
  }, [items, loading, error]);

  return (
    <section className="space-y-4" aria-busy={loading}>
      <div className="pe-9">
        <h2 id={titleId} className="text-lg font-semibold tracking-tight">
          {copy.title}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {props.workspaceId ? copy.description : copy.allServers}
        </p>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-muted-foreground" role="status">
          {loading
            ? copy.loading
            : interpolate(copy.count, {
                count: String(count),
              })}
        </span>
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => void refresh()}>
          <Icon name="refresh" className="size-4" aria-hidden="true" />
          {copy.refresh}
        </Button>
      </div>
      {error && (
        <p role="alert" className="rounded-xl bg-danger/5 p-3 text-sm text-danger">
          {error}
        </p>
      )}
      {!loading && !error && items.length === 0 && (
        <div className="rounded-xl bg-muted/40 p-4 text-sm text-muted-foreground">{copy.empty}</div>
      )}
      <div className="space-y-3">
        {items.map((item) => (
          <CheckoutRow
            key={item.id}
            {...props}
            item={item}
            onRefresh={refresh}
            onCleared={() => {
              markCleared(item.id);
              props.onCleared?.();
            }}
          />
        ))}
      </div>
    </section>
  );
}

function CheckoutRow({
  item,
  preserveProject = false,
  onCleared,
  onCheckoutStarted,
  onServerRemoved,
  onChoosePlan,
  onRefresh,
}: RecoveryProps & {
  item: BillingPendingCheckout;
  onRefresh: () => Promise<void>;
}) {
  const { t, locale } = useI18n();
  const copy = t.billing.pendingPayments;
  const { organizationId } = useBillingScope();
  const router = useRouter();
  const [busy, setBusy] = useState<"resume" | "cancel" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [result, setResult] = useState<BillingCheckoutActionResult | null>(null);
  const [cancelAttempted, setCancelAttempted] = useState(false);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A completed provider read supersedes our conservative local cancellation state.
  useEffect(() => {
    setCancelAttempted(item.state === "canceling");
  }, [item]);
  const actions = useManagedServerActions(item.server.serverId, () => {
    if (!mounted.current) return;
    setRemoved(true);
    setDeleting(false);
    onServerRemoved?.(item.server.id);
    router.refresh();
  });
  const expired = result?.status === "expired";
  const processing = result?.status === "processing" || item.state === "processing";
  const canceling = cancelAttempted || item.state === "canceling" || result?.status === "canceling";
  const unused =
    item.server.projectCount === 0 &&
    item.server.resources === null &&
    item.server.planTierId === "free";
  const scope = { workspaceId: item.server.id, organizationId };
  const paymentId = result?.checkoutId ?? item.checkoutId;
  const statusHref = scopedBillingHref(
    `/billing/overview?${item.kind === "topup" ? "topup" : "checkout"}=success${paymentId ? `&session_id=${encodeURIComponent(paymentId)}` : ""}`,
    scope,
  );
  const status = expired
    ? copy.canceled
    : processing
      ? copy.states.processing
      : canceling
        ? copy.states.canceling
        : copy.states[item.state];

  async function run(operation: "resume" | "cancel") {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(operation);
    setError(null);
    setConfirmCancel(false);
    const navigation = operation === "resume" ? beginCheckoutNavigation(preserveProject) : null;
    if (operation === "cancel") setCancelAttempted(true);
    try {
      const response = await billingApi[
        operation === "resume" ? "resumeCheckout" : "cancelCheckout"
      ]({ workspaceId: item.server.id, id: item.id });
      if (!mounted.current) {
        navigation?.close();
        return;
      }
      setResult(response);
      if (response.status === "ready") {
        if (!response.checkoutUrl || !navigation) throw new Error(copy.actionError);
        const url = navigation.navigate(response.checkoutUrl);
        if (preserveProject) {
          setCheckoutUrl(url);
          onCheckoutStarted?.(url);
        }
        void onRefresh();
      } else {
        navigation?.close();
        setCheckoutUrl(null);
        if (response.status === "expired") onCleared?.();
        router.refresh();
      }
    } catch (err) {
      navigation?.close();
      if (!mounted.current) return;
      setError(getApiErrorMessage(err, copy.actionError));
      if (getApiErrorCode(err) === "BILLING_CHECKOUT_CANCEL_UNAVAILABLE") setCancelAttempted(false);
      // A failed request may already have reached the payment provider.
      // Refresh reads persisted recovery state; it never starts another checkout.
      void onRefresh();
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(null);
    }
  }

  if (removed)
    return (
      <p role="status" className="rounded-xl bg-muted/40 p-4 text-sm">
        {copy.removing}
      </p>
    );
  return (
    <article className="space-y-4 rounded-2xl bg-muted/40 p-4" aria-busy={busy !== null}>
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate text-base font-medium">{item.name}</h3>
          <Link
            href={cloudSpaceHref(item.server.serverId)}
            className="mt-1 inline-block text-sm text-muted-foreground hover:text-foreground focus-visible:outline-ring"
          >
            {item.server.name}
          </Link>
        </div>
        <div className="shrink-0 text-end">
          <p className="text-lg font-semibold tabular-nums">
            <bdi>
              {new Intl.NumberFormat(locale, { style: "currency", currency: item.currency }).format(
                item.amountCents / 100,
              )}
            </bdi>
          </p>
          <p className="text-xs text-muted-foreground">
            {item.interval ? copy[item.interval] : copy.oneTime}
          </p>
        </div>
      </div>
      <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
        <Icon name={expired ? "check" : "clock"} className="size-4 shrink-0" aria-hidden="true" />
        {status}
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {!expired && !processing && !canceling && item.state === "open" && !item.canCancel && (
        <p className="text-xs leading-5 text-muted-foreground">
          {item.cancelUnavailableReason === "unsupported"
            ? copy.cancelUnsupported
            : copy.cancelUnavailable}
          {item.cancelUnavailableReason !== "provider_unavailable" && (
            <>
              {" "}
              <Link href="/support" className="underline underline-offset-2">
                {copy.support}
              </Link>
            </>
          )}
        </p>
      )}
      {confirmCancel ? (
        <div className="space-y-3 rounded-xl bg-background/50 p-3">
          <p className="text-sm text-muted-foreground">{copy.cancelHint}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy !== null}
              onClick={() => void run("cancel")}
            >
              {copy.confirmCancel}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmCancel(false)}>
              {copy.keep}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {!expired && !processing && !canceling && item.canResume && (
            <Button size="sm" disabled={busy !== null} onClick={() => void run("resume")}>
              {busy === "resume"
                ? copy.opening
                : item.state === "unconfirmed"
                  ? copy.recover
                  : copy.resume}
            </Button>
          )}
          {!expired && !processing && (item.canCancel || canceling) && (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy !== null}
              onClick={() => (canceling ? void run("cancel") : setConfirmCancel(true))}
            >
              {busy === "cancel"
                ? copy.states.canceling
                : canceling
                  ? copy.retryCancel
                  : copy.cancel}
            </Button>
          )}
          {processing && (
            <Button asChild size="sm">
              <Link
                href={statusHref}
                target={preserveProject ? "_blank" : undefined}
                rel={preserveProject ? "noopener noreferrer" : undefined}
              >
                {copy.viewStatus}
              </Link>
            </Button>
          )}
          {expired &&
            (preserveProject && onChoosePlan ? (
              <Button size="sm" variant="secondary" onClick={onChoosePlan}>
                {copy.choosePlan}
              </Button>
            ) : (
              <Button asChild size="sm" variant="secondary">
                <Link href={scopedBillingHref("/billing/plans", scope)} onClick={onChoosePlan}>
                  {copy.choosePlan}
                </Link>
              </Button>
            ))}
          {expired && unused && (
            <Button
              size="sm"
              variant="ghost"
              className="text-danger hover:text-danger"
              disabled={actions.busy}
              onClick={() => setDeleting(true)}
            >
              {copy.deleteServer}
            </Button>
          )}
          {checkoutUrl && !expired && !processing && !canceling && (
            <Button asChild size="sm" variant="secondary">
              <a href={checkoutUrl} target="_blank" rel="noopener noreferrer">
                {copy.openPayment}
              </a>
            </Button>
          )}
        </div>
      )}
      <ManagedServerActionFeedback
        server={item.server}
        actions={actions}
        deleting={deleting}
        onCancelDelete={() => setDeleting(false)}
      />
    </article>
  );
}
