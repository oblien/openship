"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowUpCircle, Loader2, RefreshCw } from "lucide-react";

import { updatesApi, type UpdateStatusItem } from "@/lib/api/updates";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/components/toast";
import CopyCommand, { SELF_UPDATE_COMMAND } from "@/components/shared/CopyCommand";
import HomeTipCard from "./HomeTipCard";

interface UpdatesBlockProps {
  projectCount: number;
  loading: boolean;
}

/**
 * Home "Updates available" surface — the alert-driven replacement for the static
 * quick-tip in the right column. Lists every app/project/self-app/webmail with a
 * pending update ("new release for X") and an inline Update action that applies
 * it (force-pull + redeploy, pre-deploy backup). When nothing is behind it
 * gracefully falls back to the product tip so the slot never goes empty.
 */
export default function UpdatesBlock({ projectCount, loading }: UpdatesBlockProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const c = t.overview.updates;

  const [items, setItems] = useState<UpdateStatusItem[] | null>(null);
  const [applying, setApplying] = useState<Set<string>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await updatesApi.list(true);
      setItems(res.data);
    } catch {
      setItems([]); // fail-soft → fall back to the tip
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply(item: UpdateStatusItem) {
    setApplying((prev) => new Set(prev).add(item.projectId));
    try {
      await updatesApi.apply(item.projectId);
      toast("success", interpolate(c.started, { name: item.name }));
      setItems(
        (prev) =>
          prev?.map((i) =>
            i.projectId === item.projectId ? { ...i, latestInProgress: true } : i,
          ) ?? null,
      );
    } catch (e) {
      // Prefer the server's own reason — several refusals are actionable
      // ("deploy this project first", "the control plane updates itself") and
      // a flat "try again" told the operator to repeat something that can't work.
      toast("error", getApiErrorMessage(e, c.failed));
      setApplying((prev) => {
        const next = new Set(prev);
        next.delete(item.projectId);
        return next;
      });
    }
  }

  // Still loading OR nothing to update → show the quick tip instead.
  if (items === null || items.length === 0) {
    return <HomeTipCard projectCount={projectCount} loading={loading} />;
  }

  return (
    <div className="rounded-2xl border border-warning-border bg-warning-bg/40 p-5">
      <div className="mb-3 flex items-center gap-2">
        <ArrowUpCircle className="size-4 text-warning" />
        <h3 className="text-sm font-semibold text-foreground">{c.title}</h3>
        <span className="ms-auto text-xs text-muted-foreground">{items.length}</span>
      </div>

      <ul className="space-y-2.5">
        {items.map((item) => {
          const busy = applying.has(item.projectId) || item.latestInProgress;
          const versionLabel =
            item.currentLabel && item.latestLabel
              ? `${item.currentLabel} → ${item.latestLabel}`
              : item.latestLabel ?? c.newVersion;
          // The Openship control plane is listed here (the scan reports its
          // version drift) but the API refuses to redeploy it on purpose — it
          // upgrades itself through the CLI. Offer the command, not a button
          // that is guaranteed to 403.
          const viaCli = item.appTemplateId === "openship";
          return (
            <li key={item.projectId} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-foreground">{item.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{versionLabel}</p>
              </div>
              {viaCli ? (
                <CopyCommand command={SELF_UPDATE_COMMAND} className="shrink-0" />
              ) : (
                <button
                  type="button"
                  onClick={() => void apply(item)}
                  disabled={busy}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-warning-border px-2.5 py-1 text-xs font-medium text-warning transition-colors hover:bg-warning-bg disabled:opacity-60"
                >
                  {busy ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <RefreshCw className="size-3" />
                  )}
                  {busy ? c.updating : c.updateAction}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
