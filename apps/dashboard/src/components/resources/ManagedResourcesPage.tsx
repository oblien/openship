"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import { useCloudResourceKey } from "@/context/CloudResourceContext";
import { useI18n } from "@/components/i18n-provider";
import { getApiErrorMessage, systemApi } from "@/lib/api";
import type { ServerInfo } from "@/lib/api/system";
import { newServerBillingHref, workspaceBillingHref } from "@/lib/billing-links";
import { PageContainer } from "@/components/ui/PageContainer";
import { Button } from "@/components/ui/button";
import { CloudSpaceSelector } from "./CloudSpaceSelector";
import { cloudSpaceHref } from "@/lib/cloud-spaces";
import { Tabs } from "@/components/ui/Tabs";
import { CapacitySummary } from "@/components/shared/CapacitySummary";
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
  const router = useRouter();
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
        pools={servers ?? []}
        onRefresh={refresh}
        refreshing={refreshing}
        error={error}
        onSelect={(id) => router.replace(cloudSpaceHref(id), { scroll: false })}
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
  pools = [],
  onRefresh,
  refreshing = false,
  error,
  onSelect,
}: {
  server: ServerInfo;
  pools?: ServerInfo[];
  onRefresh: () => Promise<void>;
  refreshing?: boolean;
  error?: string | null;
  onSelect?: (id: string) => void;
}) {
  const { t } = useI18n();
  const copy = t.servers.resources;
  const router = useRouter();
  const query = useSearchParams();
  const [revision, setRevision] = useState(0);
  const managed = server.managed;
  const actions = useManagedServerActions(server.id, () => {
    void onRefresh();
  });
  const activity = query.get("tab") === "activity";
  if (!managed) return null;
  const refresh = () => {
    setRevision((value) => value + 1);
    void onRefresh();
  };
  const changeTab = (tab: string) => {
    const params = new URLSearchParams(query.toString());
    params.set("pool", server.id);
    if (tab === "activity") params.set("tab", tab);
    else params.delete("tab");
    router.replace(`/resources?${params}`, { scroll: false });
  };
  return (
    <PageContainer className="@container/resources">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-medium text-foreground">{t.dashboard.nav.resources}</h1>
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
          {!managed.connectionIssue && (
            <Button asChild variant="secondary">
              <Link href={newServerBillingHref()}>
                <Icon name="plus" className="size-4" />
                {copy.addCapacity}
              </Link>
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p role="alert" className="mb-4 rounded-xl bg-card p-4 text-sm text-danger">
          {error}
        </p>
      )}
      <Tabs
        tabs={[
          { key: "overview", label: t.servers.detail.tabs.overview },
          { key: "activity", label: t.servers.detail.tabs.activity },
        ]}
        value={activity ? "activity" : "overview"}
        onChange={changeTab}
        className="mb-6"
      />
      <div className="grid items-start gap-5 @min-[64rem]/resources:grid-cols-[minmax(0,1fr)_340px] @min-[64rem]/resources:grid-rows-[auto_1fr]">
        <CloudSpaceSelector
          spaces={pools.length ? pools : [server]}
          selected={server.id}
          onSelect={onSelect}
        />
        <div className="min-w-0 space-y-5 @min-[64rem]/resources:col-start-1 @min-[64rem]/resources:row-start-1 @min-[64rem]/resources:row-span-2">
          {managed.connectionIssue ? (
            <ManagedServerConnectionNotice
              issue={managed.connectionIssue}
              refresh={refresh}
              busy={refreshing}
            />
          ) : activity ? (
            <ManagedServerActivity server={managed} actions={actions} />
          ) : (
            <ServerUsage
              key={server.id}
              serverId={server.id}
              resources={managed.resources}
              showProjects
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
              projectTitle={copy.projects}
              refreshKey={`${revision}:${managed.state}`}
            />
          )}
          {actions.error && (
            <p role="alert" className="rounded-xl bg-card p-4 text-sm text-danger">
              {actions.error}
            </p>
          )}
        </div>
        {!managed.connectionIssue && (
          <aside className="space-y-4 rounded-2xl bg-card p-5 @min-[64rem]/resources:col-start-2 @min-[64rem]/resources:row-start-2">
            <h2 className="text-base font-medium">{copy.capacity}</h2>
            {managed.resources && <CapacitySummary resources={managed.resources} />}
            <p className="text-sm leading-relaxed text-muted-foreground">{copy.capacityHint}</p>
            <Button asChild className="w-full">
              <Link href={workspaceBillingHref("/billing/plans", managed.id)}>
                {copy.managePlan}
              </Link>
            </Button>
            <Link
              href={workspaceBillingHref("/billing/overview", managed.id)}
              className="block text-center text-sm text-muted-foreground hover:text-foreground"
            >
              {t.billing.subscription.manage}
            </Link>
          </aside>
        )}
      </div>
    </PageContainer>
  );
}
