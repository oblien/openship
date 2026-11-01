"use client";

import { useEffect, useState } from "react";
import type { ComputeCluster } from "@repo/contracts";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { ClusterRuntimePanel } from "@/components/servers/clusters/ClusterRuntimePanel";
import { ServerSwarm } from "@/components/servers/ServerSwarm";
import { privateNetworksApi } from "@/lib/api/private-networks";
import { computeClustersApi } from "@/lib/api/compute-clusters";
import { useI18n } from "@/components/i18n-provider";
import { getApiErrorMessage } from "@/lib/api";

/** The existing durable setup, embedded without leaving the workload draft. */
export function TopologyScalingSetup({
  cluster,
  onClose,
  onReady,
}: {
  cluster: ComputeCluster;
  onClose: () => void;
  onReady: (cluster: ComputeCluster) => void;
}) {
  const { t } = useI18n();
  const text = t.projects.quickScale;
  const [current, setCurrent] = useState<ComputeCluster | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let active = true;
    setCurrent(null);
    setError(null);
    setReady(false);
    void Promise.all([privateNetworksApi.capabilities(), computeClustersApi.get(cluster.id)])
      .then(([capabilities, fresh]) => {
        if (!active) return;
        if (!capabilities.available) throw new Error("Scaling is unavailable on this instance.");
        setCanManage(capabilities.canManage);
        setCurrent(fresh);
        setReady(fresh.scaling?.provider === "swarm" && fresh.scaling.status === "ready");
      })
      .catch((reason) => {
        if (active) setError(getApiErrorMessage(reason));
      });
    return () => {
      active = false;
    };
  }, [cluster.id, attempt]);
  const finish = async () => {
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await computeClustersApi.get(cluster.id);
      if (fresh.scaling?.status !== "ready")
        throw new Error("Scaling readiness changed. Refresh setup before continuing.");
      onReady(fresh);
    } catch (reason) {
      setError(getApiErrorMessage(reason));
      setReady(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      isOpen
      onClose={onClose}
      width="min(860px, 96vw)"
      maxWidth="96vw"
      showCloseButton={false}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={text.prepare}
        className="space-y-5 p-5 sm:p-7"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-medium">{text.prepare}</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {cluster.name} · {text.setupHint}
            </p>
          </div>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t.settings.common.close}
          </Button>
        </div>
        {error && (
          <div role="alert" className="space-y-2 text-sm text-danger">
            <p>{error}</p>
            <Button variant="outline" onClick={() => setAttempt((value) => value + 1)}>
              {text.refreshSetup}
            </Button>
          </div>
        )}
        {!current && !error && (
          <p role="status" className="animate-pulse text-sm text-muted-foreground">
            {text.loadingSetup}
          </p>
        )}
        {current?.scaling?.provider === "swarm" ? (
          <div className="space-y-3">
            <ServerSwarm serverId={current.serverIds[0]} connected />
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setAttempt((value) => value + 1)}
            >
              {text.refreshSetup}
            </Button>
          </div>
        ) : (
          current && (
            <ClusterRuntimePanel
              key={`${current.id}:${attempt}`}
              cluster={current}
              canManage={canManage}
              embedded
              onReadyChange={setReady}
            />
          )
        )}
        {current && !canManage && (
          <p className="text-sm text-muted-foreground">{text.adminSetup}</p>
        )}
        {ready && (
          <Button className="w-full" onClick={() => void finish()} disabled={busy}>
            {text.continueCluster}
          </Button>
        )}
        <p className="text-xs text-muted-foreground">{text.closeSetupHint}</p>
      </div>
    </Modal>
  );
}
