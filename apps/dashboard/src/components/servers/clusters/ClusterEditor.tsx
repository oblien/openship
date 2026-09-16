"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { ClusterCapabilities, ServerCluster } from "@repo/contracts";
import { PageContainer } from "@/components/ui/PageContainer";
import { useI18n } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { getApiErrorMessage } from "@/lib/api";
import { serverClustersApi } from "@/lib/api/server-clusters";
import { ClusterWizard } from "./ClusterWizard";
import { clusterStatus } from "./model";

/** Shared route boundary for creating and editing, including direct URL access. */
export function ClusterEditor({ clusterId }: { clusterId?: string }) {
  const { t } = useI18n();
  const c = t.servers.clusters;
  const router = useRouter();
  const { selfHosted, deployMode } = usePlatform();
  const eligible = selfHosted && deployMode !== "cloud";
  const backHref = clusterId ? `/servers/clusters/${clusterId}` : "/servers?tab=cluster";
  const [data, setData] = useState<{
    capabilities: ClusterCapabilities;
    cluster?: ServerCluster;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    setData(null);
    setError(null);
    if (eligible) {
      void (async () => {
        try {
          const capabilities = await serverClustersApi.capabilities();
          if (!current) return;
          const cluster =
            capabilities.available && capabilities.canManage && clusterId
              ? await serverClustersApi.get(clusterId)
              : undefined;
          if (current) setData({ capabilities, cluster });
        } catch (err) {
          if (current) setError(getApiErrorMessage(err));
        }
      })();
    }
    return () => {
      current = false;
    };
  }, [clusterId, eligible, attempt]);

  const unavailable = !eligible
    ? c.selfHostedOnly
    : data && !data.capabilities.available
      ? data.capabilities.reason || c.selfHostedOnly
      : data && !data.capabilities.canManage
        ? c.managePermissionRequired
        : data?.cluster && clusterStatus(data.cluster) === "checking"
          ? c.editWhileVerifying
          : null;

  return (
    <PageContainer>
      {data && !unavailable && !error ? (
        <ClusterWizard
          capabilities={data.capabilities}
          initial={data.cluster}
          onCancel={() => router.push(backHref)}
          onSaved={(cluster) => router.replace(`/servers/clusters/${cluster.id}`)}
        />
      ) : (
        <>
          <Link
            href={backHref}
            className="mb-5 inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4 rtl:rotate-180" />
            {clusterId ? c.back : c.backToClusters}
          </Link>
          <h1 className="mb-6 text-2xl font-semibold tracking-tight">
            {clusterId ? c.editCluster : c.createCluster}
          </h1>
          {unavailable ? (
            <p role="status" className="rounded-xl bg-muted/50 p-5 text-sm text-muted-foreground">
              {unavailable}
            </p>
          ) : error ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-xl bg-danger/10 p-4 text-sm text-danger"
            >
              <span>{error}</span>
              <button
                type="button"
                className="shrink-0 font-medium underline"
                onClick={() => setAttempt((old) => old + 1)}
              >
                {c.retry}
              </button>
            </div>
          ) : (
            <div role="status" aria-label={c.setupSteps} className="flex justify-center py-16">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}
        </>
      )}
    </PageContainer>
  );
}
