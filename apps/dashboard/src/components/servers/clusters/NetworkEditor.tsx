"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowLeft, Loader2 } from "lucide-react";
import type { ClusterCapabilities, ServerCluster } from "@repo/contracts";
import { managedNetworkUnsettled, type ManagedNetworkPreparation } from "@repo/core";
import { PageContainer } from "@/components/ui/PageContainer";
import { useI18n } from "@/components/i18n-provider";
import { usePlatform } from "@/context/PlatformContext";
import { getApiErrorMessage } from "@/lib/api";
import { computeClustersApi } from "@/lib/api/compute-clusters";
import { privateNetworksApi } from "@/lib/api/private-networks";
import { NetworkWizard } from "./NetworkWizard";
import { clusterStatus } from "./model";

/** Shared route boundary for creating and editing, including direct URL access. */
export function NetworkEditor({
  clusterId,
  preparationId,
}: {
  clusterId?: string;
  preparationId?: string;
}) {
  const { t } = useI18n();
  const c = t.servers.networks;
  const router = useRouter();
  const fromNetworks = useSearchParams().get("from") === "networking";
  const detailQuery = fromNetworks ? "?tab=network&from=networking" : "";
  const { selfHosted, deployMode } = usePlatform();
  const eligible = selfHosted && deployMode !== "cloud";
  const backHref = clusterId
    ? `/servers/networks/${clusterId}${detailQuery}`
    : "/servers?tab=networking";
  const [data, setData] = useState<{
    capabilities: ClusterCapabilities;
    cluster?: ServerCluster;
    preparation?: ManagedNetworkPreparation;
    protectedServerIds: string[];
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
          const capabilities = await privateNetworksApi.capabilities();
          if (!current) return;
          const cluster =
            capabilities.available && capabilities.canManage && clusterId
              ? await privateNetworksApi.get(clusterId)
              : undefined;
          const preparation =
            capabilities.available && capabilities.canManage && preparationId
              ? await privateNetworksApi.managedPreparation(preparationId)
              : undefined;
          if (preparation && preparation.input.clusterId !== clusterId)
            throw new Error(c.invalidConfig);
          const groups = cluster ? await computeClustersApi.list() : [];
          const protectedServerIds = groups
            .filter((group) => group.networkId === clusterId)
            .flatMap((group) => group.serverIds);
          if (current) setData({ capabilities, cluster, preparation, protectedServerIds });
        } catch (err) {
          if (current) setError(getApiErrorMessage(err));
        }
      })();
    }
    return () => {
      current = false;
    };
  }, [clusterId, preparationId, eligible, attempt, c.invalidConfig]);

  const unavailable = !eligible
    ? c.selfHostedOnly
    : data && !data.capabilities.available
      ? data.capabilities.reason || c.selfHostedOnly
      : data && !data.capabilities.canManage
        ? c.managePermissionRequired
        : data?.cluster?.operation && managedNetworkUnsettled(data.cluster.operation.status)
          ? c.managed.recoveryHint
          : data?.cluster && clusterStatus(data.cluster) === "checking"
            ? c.editWhileVerifying
            : null;

  return (
    <PageContainer>
      {data && !unavailable && !error ? (
        <NetworkWizard
          capabilities={data.capabilities}
          protectedServerIds={data.protectedServerIds}
          initial={data.cluster}
          initialRequest={data.preparation?.input}
          onCancel={() => router.push(backHref)}
          onSaved={(cluster) => router.replace(`/servers/networks/${cluster.id}${detailQuery}`)}
          onManagedPreparation={(preparation) =>
            router.push(`/servers/networks/preparations/${preparation.id}`)
          }
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
            <div role="status" className="rounded-xl bg-muted/50 p-5 text-sm text-muted-foreground">
              <p>{unavailable}</p>
              {data?.cluster?.operation && (
                <Link
                  className="mt-3 inline-block font-medium text-primary"
                  href={`/servers/networks/operations/${data.cluster.operation.id}`}
                >
                  {c.managed.viewOperation}
                </Link>
              )}
            </div>
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
