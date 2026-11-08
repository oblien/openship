"use client";

import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon, type IconName } from "@repo/ui/icons";
import type { ManagementState, ServerDetail } from "@repo/contracts";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { CapacitySummary } from "@/components/shared/CapacitySummary";
import { ManagedServerStatus } from "@/components/servers/managed/ManagedServerStatus";
import { useServerDestinations } from "@/hooks/useServerDestinations";
import { cloudSpaceHref } from "@/lib/cloud-spaces";
import { newServerBillingHref, scopedBillingHref } from "@/lib/billing-links";
import { BillingHeader } from "@/app/(dashboard)/billing/_components/BillingHeader";
import { useManagementPlan } from "./useManagementPlan";

/** One account-scoped overview, using the same inventory and saved Manage contract as details. */
export function BillingHome() {
  const { t } = useI18n();
  const router = useRouter();
  const inventory = useServerDestinations();
  const management = useManagementPlan({ refreshIdle: false });
  const spaces =
    inventory.data?.servers.filter(
      ({ managed }) => managed && (managed.planTierId !== "free" || managed.resources),
    ) ?? [];
  const subscription = management.data?.subscription;
  const hasPlans = spaces.length > 0 || Boolean(subscription);
  const loading = inventory.loading || management.loading;
  const error = inventory.error || management.error;
  const openingPlans = !loading && !error && !hasPlans;
  const plansHref = newServerBillingHref(inventory.organizationId);
  useEffect(() => {
    if (openingPlans) router.replace(plansHref);
  }, [openingPlans, plansHref, router]);
  const refresh = () => {
    inventory.refresh();
    management.refresh();
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
  organizationId,
  showAddPlan = true,
}: {
  spaces: Array<Pick<ServerDetail, "id" | "name" | "managed">>;
  management: Pick<ManagementState, "active" | "subscription"> | null;
  organizationId?: string;
  showAddPlan?: boolean;
}) {
  const { t } = useI18n();
  const subscription = management?.subscription;
  const plansHref = newServerBillingHref(organizationId);
  return (
    <div className="grid items-stretch gap-5 @min-[36rem]/billing-home:grid-cols-2 @min-[66rem]/billing-home:grid-cols-3">
      {spaces.map((server) => {
        const space = server.managed!;
        return (
          <PlanCard
            key={server.id}
            href={cloudSpaceHref(server.id)}
            icon="cloud"
            kind={t.servers.resources.space}
            title={server.name || space.name}
            status={<ManagedServerStatus workspace={space} />}
            footer={interpolate(t.billing.workspaces.projectCount, {
              count: String(space.projectCount),
            })}
          >
            <p className="text-sm leading-6 text-muted-foreground">
              {t.servers.resources.description}
            </p>
            {space.resources && <CapacitySummary resources={space.resources} />}
          </PlanCard>
        );
      })}
      {subscription && (
        <PlanCard
          href={scopedBillingHref("/billing/manage", {
            organizationId,
          })}
          icon="server"
          kind={t.billing.hub.management}
          title={`Openship Manage · ${t.billing.managementPlans[subscription.plan ?? "basic"]}`}
          status={
            <span className="text-xs text-muted-foreground">
              {management?.active ? t.billing.hub.active : t.billing.hub.inactive}
            </span>
          }
          footer={interpolate(t.billing.managementPlans.serversIncluded, {
            count: String(subscription.servers),
          })}
        >
          <p className="text-sm leading-6 text-muted-foreground">
            {t.billing.purchase.manageDescription}
          </p>
          <div className="rounded-xl bg-muted/40 p-3 text-sm">
            {subscription.plan === "priority"
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
