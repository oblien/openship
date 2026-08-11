"use client";

import React from "react";
import { RotateCcw, AlertTriangle } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { RestorePlanUI } from "@/lib/api";

interface RollbackConfirmDialogProps {
  isOpen: boolean;
  /** Null while the plan is still loading, or when the API couldn't answer. */
  plan: RestorePlanUI | null;
  /** Resolved mode line ("instant" / "rebuild" / "mostly instant"). */
  modeLine: string;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Rollback confirm. Replaces a `window.confirm`, which is why the env diff had
 * nowhere to live before this: a rollback replays the release's frozen env OVER
 * today's values, so it can revert a rotated secret. That is the intended
 * behaviour — "old code, new config" is a combination nobody ever ran — but it
 * has to be visible before the operator commits, which needs a table.
 *
 * The API sends KEYS ONLY. There is no reveal affordance here on purpose.
 */
export const RollbackConfirmDialog: React.FC<RollbackConfirmDialogProps> = ({
  isOpen,
  plan,
  modeLine,
  busy,
  onConfirm,
  onClose,
}) => {
  const { t } = useI18n();
  const c = t.deployments.rollbackConfirm;
  const env = plan?.env;
  const untouched = plan?.untouchedServices ?? [];

  const directionLabel = (direction: string): string => {
    if (direction === "frozen-wins") return c.dirFrozenWins;
    if (direction === "removed-since") return c.dirRemovedSince;
    return env?.strategy === "replace" ? c.dirAddedSinceDropped : c.dirAddedSinceKept;
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} maxWidth="34rem" showCloseButton={false}>
      <div className="p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <RotateCcw className="w-5 h-5 text-primary" />
          </div>
          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-foreground">{c.title}</h2>
            {modeLine && <p className="text-sm text-muted-foreground">{modeLine}</p>}
            <p className="text-sm text-muted-foreground">{c.dataUnchanged}</p>
          </div>
        </div>

        {plan?.rebuildServices && plan.rebuildServices.length > 0 && (
          <p className="text-sm text-muted-foreground font-mono break-all">
            {plan.rebuildServices.join(", ")}
          </p>
        )}

        {env && (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-medium text-foreground">{c.envHeading}</h3>
              <span className="text-xs text-muted-foreground">{c.envNoValues}</span>
            </div>
            {env.strategy === "unchanged" ? (
              <p className="text-sm text-muted-foreground">{c.envUnchanged}</p>
            ) : env.totalChanges === 0 ? (
              <p className="text-sm text-muted-foreground">{c.envNoChanges}</p>
            ) : (
              <>
                <p className="text-sm text-warning">
                  {interpolate(
                    env.strategy === "replace" ? c.envSummaryReplace : c.envSummaryOverlay,
                    { count: String(env.totalChanges) },
                  )}
                </p>
                <ul className="max-h-52 overflow-y-auto rounded-xl bg-muted/50 divide-y divide-border/50">
                  {env.changes.map((change) => (
                    <li key={`${change.key}:${change.serviceName ?? ""}`} className="px-3 py-2">
                      <div className="flex items-baseline justify-between gap-3">
                        <code className="text-xs text-foreground break-all">{change.key}</code>
                        <span className="text-xs text-muted-foreground text-end shrink-0">
                          {directionLabel(change.direction)}
                        </span>
                      </div>
                      {change.scopeAmbiguous && (
                        <p className="mt-1 flex items-start gap-1.5 text-xs text-warning">
                          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                          <span>
                            {change.serviceName ? `${change.serviceName} — ` : ""}
                            {c.scopeAmbiguous}
                          </span>
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                {env.truncated && (
                  <p className="text-xs text-muted-foreground">
                    {interpolate(c.envTruncated, {
                      shown: String(env.changes.length),
                      total: String(env.totalChanges),
                    })}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {untouched.length > 0 && (
          <div className="space-y-1">
            <h3 className="text-sm font-medium text-foreground">{c.untouchedHeading}</h3>
            <p className="text-sm text-muted-foreground">
              {interpolate(c.untouchedNote, { names: untouched.join(", ") })}
            </p>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl text-sm text-foreground/70 hover:bg-muted transition-colors"
          >
            {c.cancel}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {c.confirm}
          </button>
        </div>
      </div>
    </Modal>
  );
};
