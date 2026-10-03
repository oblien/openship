"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CloudWorkspaceSummary } from "@repo/contracts";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { ManagedServerActionFeedback } from "@/components/servers/managed/ManagedServerActionFeedback";
import { useManagedServerActions } from "@/components/servers/managed/useManagedServerActions";
import { systemApi } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";
import type { BillingState } from "@/lib/api/billing";

/** Billing shares the server's revision check, restart confirmation and worker. */
export function SubscribedServerResources({ state }: { state: BillingState }) {
  const { selfHosted } = usePlatform();
  const serverId = state.workspace?.serverId;
  if (selfHosted || !serverId || state.tier === "free" || state.status !== "active" || !state.plan?.resourceLimits) return null;
  return <ResourceChange key={serverId} serverId={serverId} state={state} />;
}

function ResourceChange({ serverId, state }: { serverId: string; state: BillingState }) {
  const { t } = useI18n();
  const router = useRouter();
  const [server, setServer] = useState<CloudWorkspaceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const actions = useManagedServerActions(serverId, updated => { setServer(updated); router.refresh(); });
  const pending = ["queued", "running"].includes(server?.operation?.status ?? "");
  const resizeFailed = server?.operation?.kind === "resize" && server.operation.status === "failed";

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function refresh() {
      try {
        const value = await systemApi.getServerById(serverId);
        if (disposed) return;
        setError(null);
        setServer(value.managed ?? null);
        if (["queued", "running"].includes(value.managed?.operation?.status ?? ""))
          timer = setTimeout(refresh, 5_000);
      } catch (failure) {
        if (!disposed) setError(getApiErrorMessage(failure));
      }
    }
    void refresh();
    return () => { disposed = true; clearTimeout(timer); };
  }, [serverId, state.subscription?.offerReference, pending, attempt]);

  const saved = state.plan!.resourceLimits!;
  const allocated = server?.resources;
  const changed = allocated && (
    saved.max_total_vcpus !== allocated.cpuCores || saved.max_total_ram_mb !== allocated.memoryMb ||
    (saved.max_total_disk_gb != null && saved.max_total_disk_gb * 1024 !== allocated.diskMb)
  );
  if (!error && !changed && !actions.preview && !actions.error && server?.operation?.kind !== "resize") return null;
  if (!error && !changed && !actions.preview && !actions.error && !pending && server?.operation?.status === "succeeded") return null;

  return (
    <section className="space-y-4 rounded-2xl bg-card p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-medium">{t.billing.custom.resizeTitle}</h2>
        <Button asChild variant="ghost" size="sm"><Link href={`/servers/${encodeURIComponent(serverId)}`}>{t.billing.custom.openServer}</Link></Button>
      </div>
      {error ? (
        <div role="alert" className="space-y-3 text-sm text-danger">
          <p>{error}</p>
          <Button variant="secondary" size="sm" onClick={() => setAttempt(value => value + 1)}>{t.billing.plansRoute.tryAgain}</Button>
        </div>
      ) : (
        <>
          <p role={pending ? "status" : undefined} className="text-sm text-muted-foreground">
            {pending ? t.billing.custom.applying : t.billing.custom.resizeDescription}
          </p>
          {resizeFailed && server.operation!.error && <p role="alert" className="text-sm text-danger">{server.operation!.error}</p>}
          {!actions.preview && (
            <Button variant="secondary" disabled={actions.busy || pending} onClick={() => void (resizeFailed ? actions.retry() : actions.previewResize())}>
              {resizeFailed ? t.billing.plansRoute.tryAgain : t.billing.custom.reviewResize}
            </Button>
          )}
          {server && <ManagedServerActionFeedback server={server} actions={actions} deleting={false} onCancelDelete={() => {}} />}
        </>
      )}
    </section>
  );
}
