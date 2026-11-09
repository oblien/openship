"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { useI18n } from "@/components/i18n-provider";
import { getApiErrorMessage, systemApi } from "@/lib/api";
import type { ServerInfo } from "@/lib/api/system";
import { newServerBillingHref } from "@/lib/billing-links";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { cloudSpacePlanLabel } from "@/lib/cloud-spaces";
import { CloudPlanManagement } from "@/components/billing/CloudPlanManagement";
import { ManagedServerStatus } from "@/components/servers/managed/ManagedServerStatus";
import { BillingSupportLink } from "@/components/billing/BillingSupportLink";
import { ServerUsage } from "@/components/servers/ServerUsage";
import { ManagedServerActivity } from "@/components/servers/managed/ManagedServerActivity";
import { ManagedServerConnectionNotice } from "@/components/servers/managed/ManagedServerConnectionNotice";
import { useManagedServerActions } from "@/components/servers/managed/useManagedServerActions";

/** One purchased workspace is one independent pool. Never add independent
 * allocations together and imply that a project can use their combined size. */
export function ManagedResourcesPage({ serverId }: { serverId?: string }) {
  const scope = useCloudResourceKey();
  return <Resources key={`${scope}:${serverId ?? "all"}`} serverId={serverId} />;
}

function Resources({ serverId }: { serverId?: string }) {
  const { t } = useI18n();
  const copy = t.servers.resources;
  const query = useSearchParams();
  const [servers, setServers] = useState<ServerInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const mounted = useRef(true);
  const fetching = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    setRefreshing(true);
    try {
      const rows = serverId
        ? [await systemApi.getServerById(serverId)]
        : await systemApi.listServers();
      if (!mounted.current) return;
      setServers(rows.filter((row) => row.managed && row.purpose !== "migration_source"));
      setError(null);
    } catch (failure) {
      if (mounted.current) setError(getApiErrorMessage(failure));
    } finally {
      fetching.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, [serverId]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const pending = servers?.some((row) =>
    ["queued", "running"].includes(row.managed?.operation?.status ?? ""),
  );
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 3000);
    return () => clearInterval(timer);
  }, [pending, refresh]);
  const requested = serverId ?? query.get("pool");
  const selected = requested ? servers?.find((row) => row.id === requested) : servers?.[0];
  if (selected)
    return (
      <ManagedResourceDetail
        key={selected.id}
        server={selected}
        onRefresh={refresh}
        refreshing={refreshing}
        error={error}
      />
    );
  return (
    <PageContainer>
      <h1 className="text-2xl font-medium text-foreground">{t.dashboard.nav.resources}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
      {error ? (
        <div
          role="alert"
          className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card p-5"
        >
          <p className="text-sm text-danger">{error}</p>
          <Button variant="secondary" disabled={refreshing} onClick={() => void refresh()}>
            {t.billing.plansRoute.tryAgain}
          </Button>
        </div>
      ) : servers === null ? (
        <div
          role="status"
          aria-label={t.billing.workspaces.loading}
          className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]"
        >
          <div className="h-64 animate-pulse rounded-2xl bg-card" />
          <div className="h-64 animate-pulse rounded-2xl bg-card" />
        </div>
      ) : requested ? (
        <section role="alert" className="mt-6 space-y-3 rounded-2xl bg-card p-6">
          <h2 className="text-base font-medium">{copy.notFound}</h2>
          <p className="text-sm text-muted-foreground">{copy.notFoundDescription}</p>
          <Button asChild variant="secondary">
            <Link href="/resources">{t.dashboard.nav.resources}</Link>
          </Button>
        </section>
      ) : (
        <section className="mt-6 flex min-h-72 flex-col items-center justify-center rounded-2xl bg-card p-8 text-center">
          <div className="mb-4 rounded-2xl bg-muted/50 p-4">
            <Icon name="cloud" className="size-8 text-muted-foreground" />
          </div>
          <h2 className="text-lg font-medium">{copy.emptyTitle}</h2>
          <p className="mt-2 max-w-md text-sm text-muted-foreground">{copy.emptyDescription}</p>
          <Button asChild className="mt-5">
            <Link href={newServerBillingHref()}>{t.billing.onboarding.choosePlan}</Link>
          </Button>
        </section>
      )}
    </PageContainer>
  );
}

/** Used by canonical Resources URLs and retained /servers/:id links alike. */
export function ManagedResourceDetail({
  server,
  onRefresh,
  refreshing = false,
  error,
}: {
  server: ServerInfo;
  onRefresh: () => Promise<void>;
  refreshing?: boolean;
  error?: string | null;
}) {
  const { t, locale } = useI18n();
  const copy = t.servers.resources;
  const query = useSearchParams();
  const [revision, setRevision] = useState(0);
  const managed = server.managed;
  const actions = useManagedServerActions(server.id, () => {
    void onRefresh();
  });
  const activity = query.get("tab") === "activity";
  const usageTab = query.get("tab") === "usage";
  if (!managed) return null;
  const refresh = () => {
    setRevision((value) => value + 1);
    void onRefresh();
  };
  const header = (planName?: string) => (
    <>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium text-foreground">
            {planName ??
              (managed.planTierId === "free"
                ? copy.space
                : cloudSpacePlanLabel(managed.planTierId, locale, copy.customPlan))}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            disabled={refreshing}
            aria-label={t.billing.resourceOverview.refresh}
            onClick={refresh}
          >
            <Icon
              name="refresh"
              className={`size-4 ${refreshing ? "motion-safe:animate-spin" : ""}`}
            />
          </Button>
          {managed.planTierId !== "free" && <ManagedServerStatus workspace={managed} />}
          <BillingSupportLink />
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-card p-4 text-sm text-danger">
          {error}
        </p>
      )}
    </>
  );
  return (
    <PageContainer className="@container/resources">
      {managed.connectionIssue ? (
        <>
          {header()}
          <ManagedServerConnectionNotice
            issue={managed.connectionIssue}
            refresh={refresh}
            busy={refreshing}
          />
        </>
      ) : (
        <CloudPlanManagement
          key={managed.id}
          header={header}
          workspaceId={managed.id}
          serverId={server.id}
          server={managed}
          resources={managed.resources}
          refreshKey={revision}
          onUpdated={refresh}
        >
          <div className="space-y-5">
            {activity ? (
              <ManagedServerActivity server={managed} actions={actions} />
            ) : (
              <ServerUsage
                key={server.id}
                serverId={server.id}
                resources={managed.resources}
                showProjects={!usageTab}
                metrics={usageTab}
                resourcePool
                liveEnabled={["running", "active", "ready"].includes(managed.state)}
                unavailableHint={
                  [
                    "needs_plan",
                    "not_provisioned",
                    "not_deployed",
                    "provisioning",
                    "starting",
                    "created",
                  ].includes(managed.state)
                    ? copy.setupPending
                    : undefined
                }
                projectTitle={copy.projectsAssigned}
                refreshKey={`${revision}:${managed.state}`}
              />
            )}
            {actions.error && (
              <p role="alert" className="rounded-xl bg-card p-4 text-sm text-danger">
                {actions.error}
              </p>
            )}
          </div>
        </CloudPlanManagement>
      )}
    </PageContainer>
  );
}
