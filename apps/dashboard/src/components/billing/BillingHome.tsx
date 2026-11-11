"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@repo/ui/icons";
import type { BillingPendingCheckout, ManagementState, ServerDetail } from "@repo/contracts";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { CapacitySummary } from "@/components/shared/CapacitySummary";
import { ManagedServerStatus } from "@/components/servers/managed/ManagedServerStatus";
import { useServerDestinations } from "@/hooks/useServerDestinations";
import { cloudSpaceHref, cloudSpacePlanLabel } from "@/lib/cloud-spaces";
import { newServerBillingHref, scopedBillingHref } from "@/lib/billing-links";
import { subscriptionNeedsPayment } from "@/lib/billing-presentation";
import { BillingHeader } from "@/app/(dashboard)/billing/_components/BillingHeader";
import { useManagementPlan } from "./useManagementPlan";
import { PendingCheckoutsProvider, usePendingCheckouts } from "./PendingCheckoutsContext";

/** One account-scoped overview, using the same inventory and saved Manage contract as details. */
export function BillingHome() {
  return (
    <PendingCheckoutsProvider>
      <BillingHomeContent />
    </PendingCheckoutsProvider>
  );
}

function BillingHomeContent() {
  const { t } = useI18n();
  const router = useRouter();
  const inventory = useServerDestinations();
  const management = useManagementPlan({ refreshIdle: false });
  const pending = usePendingCheckouts()!;
  const spaces =
    inventory.data?.servers.filter(
      ({ managed }) => managed && (managed.planTierId !== "free" || managed.resources),
    ) ?? [];
  const subscription = management.data?.subscription;
  const hasPlans =
    spaces.length > 0 ||
    Boolean(subscription) ||
    pending.count > 0 ||
    Boolean(management.data?.pendingCheckout);
  const loading = inventory.loading || management.loading || pending.loading;
  const error = inventory.error || management.error || pending.error;
  const openingPlans = !loading && !error && !hasPlans;
  const plansHref = newServerBillingHref(inventory.organizationId);
  useEffect(() => {
    if (openingPlans) router.replace(plansHref);
  }, [openingPlans, plansHref, router]);
  const refresh = () => {
    inventory.refresh();
    management.refresh();
    void pending.refresh();
  };

  return (
    <PageContainer className="@container/billing-home space-y-6">
      <BillingHeader />
      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card p-5 text-sm"
        >
          <p className="text-danger">{error}</p>
          <Button variant="secondary" size="sm" onClick={refresh}>
            {t.billing.plansRoute.tryAgain}
          </Button>
        </div>
      )}
      {(loading || openingPlans) && !hasPlans ? (
        <div
          role="status"
          aria-label={t.billing.workspaces.loading}
          className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {[0, 1, 2].map((key) => (
            <div key={key} className="h-72 animate-pulse rounded-2xl bg-card" />
          ))}
        </div>
      ) : (
        <BillingPlanCards
          spaces={spaces}
          management={management.data}
          pending={pending.items}
          organizationId={inventory.organizationId}
          showAddPlan={!error}
        />
      )}
    </PageContainer>
  );
}

/** Cards for the account’s saved Cloud and management plans. */
export function BillingPlanCards({
  spaces,
  management,
  pending = [],
  organizationId,
  showAddPlan = true,
}: {
  spaces: Array<Pick<ServerDetail, "id" | "name" | "managed" | "cloudReference">>;
  management: Pick<
    ManagementState,
    "active" | "subscription" | "pendingCheckout" | "change"
  > | null;
  pending?: BillingPendingCheckout[];
  organizationId?: string;
  showAddPlan?: boolean;
}) {
  const { t, locale } = useI18n();
  const subscription = management?.subscription;
  const managementPending = Boolean(
    management?.pendingCheckout ||
    management?.change?.paymentUrl ||
    subscriptionNeedsPayment(subscription?.status),
  );
  const plansHref = newServerBillingHref(organizationId);
  const cards = new Map(
    spaces.map((server) => [server.cloudReference?.workspaceId ?? server.managed!.id, server]),
  );
  for (const item of pending) {
    if (!cards.has(item.server.id))
      cards.set(item.server.id, {
        id: item.server.serverId,
        name: item.server.name,
        managed: item.server,
      });
  }
  return (
    <div className="grid items-stretch gap-5 @min-[36rem]/billing-home:grid-cols-2 @min-[66rem]/billing-home:grid-cols-3">
      {[...cards.values()].map((server) => {
        const space = server.managed!;
        const payment = pending.find(
          (item) => item.server.id === (server.cloudReference?.workspaceId ?? space.id),
        );
        const paymentRequired = Boolean(
          payment || subscriptionNeedsPayment(space.subscriptionStatus),
        );
        return (
          <PlanCard
            key={server.id}
            href={cloudSpaceHref(server.id, paymentRequired ? "payment" : undefined)}
            icon="cloud"
            kind={t.servers.resources.space}
            title={
              space.planTierId === "free"
                ? (payment?.name ?? t.servers.resources.space)
                : cloudSpacePlanLabel(space.planTierId, locale, t.servers.resources.customPlan)
            }
            status={
              paymentRequired ? (
                <span className="rounded-full bg-danger/10 px-2 py-1 text-xs text-danger">
                  {t.billing.hub.paymentPending}
                </span>
              ) : (
                <ManagedServerStatus workspace={space} />
              )
            }
            footer={
              paymentRequired
                ? t.billing.hub.reviewPayment
                : interpolate(t.billing.workspaces.projectCount, {
                    count: String(space.projectCount),
                  })
            }
          >
            {paymentRequired && (
              <div className="space-y-1 rounded-xl bg-danger/10 p-3 text-sm text-danger">
                <p className="font-medium">{t.billing.hub.paymentRequired}</p>
                {payment && (
                  <>
                    <p>
                      {payment.name} ·{" "}
                      {new Intl.NumberFormat(locale, {
                        style: "currency",
                        currency: payment.currency,
                      }).format(payment.amountCents / 100)}
                    </p>
                    <p className="text-xs">{t.billing.pendingPayments.states[payment.state]}</p>
                  </>
                )}
              </div>
            )}
            <p className="text-sm leading-6 text-muted-foreground">
              {t.servers.resources.description}
            </p>
            {space.resources && <CapacitySummary resources={space.resources} />}
          </PlanCard>
        );
      })}
      {(subscription || management?.pendingCheckout) && (
        <PlanCard
          href={scopedBillingHref(
            managementPending ? "/billing/manage?tab=payment" : "/billing/manage",
            {
              organizationId,
            },
          )}
          icon="server"
          kind={t.billing.hub.management}
          title={
            subscription
              ? `Openship Manage · ${t.billing.managementPlans[subscription.plan ?? "basic"]}`
              : "Openship Manage"
          }
          status={
            <span className="text-xs text-muted-foreground">
              {managementPending
                ? t.billing.hub.paymentPending
                : management?.active
                  ? t.billing.hub.active
                  : t.billing.hub.inactive}
            </span>
          }
          footer={
            subscription
              ? interpolate(t.billing.managementPlans.serversIncluded, {
                  count: String(subscription.servers),
                })
              : t.billing.hub.reviewPayment
          }
        >
          {managementPending && (
            <p className="rounded-xl bg-danger/10 p-3 text-sm text-danger">
              {t.billing.hub.paymentRequired}
            </p>
          )}
          <p className="text-sm leading-6 text-muted-foreground">
            {t.billing.purchase.manageDescription}
          </p>
          <div className="rounded-xl bg-muted/40 p-3 text-sm">
            {subscription?.plan === "priority"
              ? t.billing.managementPlans.prioritySupport
              : t.billing.managementPlans.email}
          </div>
        </PlanCard>
      )}
      {showAddPlan && (
        <Link
          href={plansHref}
          className="group flex min-h-72 flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border bg-card/40 p-6 text-center transition-colors hover:bg-card focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
        >
          <span className="flex size-12 items-center justify-center rounded-2xl bg-muted">
            <Icon name="plus" className="size-5" />
          </span>
          <div className="space-y-2">
            <h2 className="text-base font-medium">{t.billing.hub.addPlan}</h2>
            <p className="max-w-60 text-sm leading-6 text-muted-foreground">
              {t.billing.hub.addHint}
            </p>
          </div>
        </Link>
      )}
    </div>
  );
}

function PlanCard({
  href,
  icon,
  kind,
  title,
  status,
  footer,
  children,
}: {
  href: string;
  icon: IconName;
  kind: string;
  title: string;
  status: ReactNode;
  footer: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const className = "flex min-w-0 flex-col gap-5 rounded-2xl bg-card p-5";
  const content = (
    <>
      <div className="flex items-start gap-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/60">
          <Icon name={icon} className="size-5" />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-xs text-muted-foreground">{kind}</p>
          <h2 className="break-words text-lg font-medium">{title}</h2>
        </div>
        {status}
      </div>
      <div className="flex-1 space-y-4">{children}</div>
      <div className="flex items-center justify-between gap-3 border-t border-border/50 pt-4 text-sm text-muted-foreground">
        <span>{footer}</span>
        <Icon name="arrow-right" className="size-4 shrink-0 rtl:rotate-180" />
      </div>
    </>
  );
  return (
    <Link
      href={href}
      aria-label={`${title} · ${t.billing.hub.viewPlan}`}
      className={`${className} transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring`}
    >
      {content}
    </Link>
  );
}
