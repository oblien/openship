"use client";

import React, { useState, useRef, useEffect } from "react";
import {
  MoreVertical,
  ExternalLink,
  Copy,
  RotateCcw,
  XCircle,
  Trash2,
  Pin,
  PinOff,
} from "lucide-react";
import { generateIcon } from "@/utils/icons";
import { deployApi, getApiErrorMessage, type RestorePlanUI } from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { RollbackConfirmDialog } from "./RollbackConfirmDialog";
import type { Deployment as DeploymentRow } from "../types";

/** Picked from the shared row type rather than re-declared with `status: string`:
 *  a local structural copy let the status checks below drift onto the API's
 *  vocabulary (`ready`) while the list mapper hands us the UI one (`success`),
 *  which silently disabled rollback and hid Pin entirely. */
type Deployment = Pick<
  DeploymentRow,
  | "id"
  | "status"
  | "domain"
  | "owner"
  | "repo"
  | "commit"
  | "artifactRetainedAt"
  | "pinned"
  | "isActive"
>;

interface DeploymentMenuProps {
  deployment: Deployment;
  triggerClassName?: string;
  onStatusChange?: () => void;
  /** Lets the row lift its stacking context while the menu is open — the
   *  dropdown's own z-index can't escape the row's. */
  onOpenChange?: (open: boolean) => void;
}

export const DeploymentMenu: React.FC<DeploymentMenuProps> = ({
  deployment,
  triggerClassName,
  onStatusChange,
  onOpenChange,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  // Wrapped in an object so a null PLAN (the preview call failed) still opens the
  // dialog — the rollback itself doesn't need the preview.
  const [confirmPlan, setConfirmPlan] = useState<{ plan: RestorePlanUI | null } | null>(null);
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [isOpen]);

  // Mirrored via effect, not wrapped around each setIsOpen call — there are six
  // of them and a new one would otherwise forget to report.
  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  // `isInFlight` = status-wise busy (the cancel/delete affordances care
  // about this). Distinct from `deployment.isActive` which means
  // "currently the active version" — the chip / rollback gating cares
  // about that one.
  const isInFlight = ["pending", "queued", "building", "deploying"].includes(deployment.status);
  const hasCommit = !!deployment.commit?.fullHash && deployment.commit.fullHash !== "N/A";
  // ONE rollback action. The API resolves HOW at call time — instant from the
  // retained artifact, or a rebuild from this deployment's commit — so the only
  // question here is whether a restore is possible AT ALL. That's why a pruned
  // artifact no longer disables the button (it used to, which left a project
  // whose releases had aged out with no rollback affordance) and why the separate
  // "Redeploy this commit" fallback is gone: it was the same operation behind a
  // second label.
  const canRollback =
    (deployment.status === "success" || deployment.status === "partial_failure") &&
    !deployment.isActive &&
    !isInFlight &&
    (!!deployment.artifactRetainedAt || hasCommit);

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    try {
      await deployApi.cancel(deployment.id);
      onStatusChange?.();
    } catch {
      /* silent */
    }
  };

  const handleRollback = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    if (!canRollback) return;
    // Ask the API how this restore will actually run so the confirm can say
    // "instant" or "rebuild" truthfully instead of guessing from a DB flag —
    // and which env keys the release's frozen snapshot would change.
    const plan = await deployApi
      .restorePlan(deployment.id)
      .then((res) => res.data)
      .catch(() => null);
    setConfirmPlan({ plan });
  };

  const confirmRollback = async () => {
    setRollbackBusy(true);
    try {
      await deployApi.rollback(deployment.id);
      setConfirmPlan(null);
      onStatusChange?.();
    } catch (err) {
      setConfirmPlan(null);
      window.alert(getApiErrorMessage(err, t.deployments.menu.rollbackFailed));
    } finally {
      setRollbackBusy(false);
    }
  };

  const modeLine = !confirmPlan
    ? ""
    : confirmPlan.plan?.mode === "rebuild"
      ? t.deployments.menu.rollbackModeRebuild
      : confirmPlan.plan?.mode === "redeploy-pinned" && confirmPlan.plan.rebuildServices.length > 0
        ? interpolate(t.deployments.menu.rollbackModeMixed, {
            count: String(confirmPlan.plan.rebuildServices.length),
          })
        : confirmPlan.plan
          ? t.deployments.menu.rollbackModeInstant
          : "";

  const handleTogglePin = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    try {
      await deployApi.pin(deployment.id, !deployment.pinned);
      onStatusChange?.();
    } catch (err) {
      window.alert(
        getApiErrorMessage(
          err,
          deployment.pinned ? t.deployments.menu.unpinFailed : t.deployments.menu.pinFailed,
        ),
      );
    }
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsOpen(false);
    try {
      await deployApi.deleteDeployment(deployment.id);
      onStatusChange?.();
    } catch {
      /* silent */
    }
  };

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        className={triggerClassName || "w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"}
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {isOpen && (
        <div className="absolute end-0 top-10 w-56 bg-popover rounded-xl shadow-lg border border-border/50 py-2 z-50 animate-in fade-in slide-in-from-top-2 duration-200">
          {deployment.domain && (
            <button
              onClick={() => {
                window.open(`https://${deployment.domain}`, "_blank");
                setIsOpen(false);
              }}
              className="w-full px-4 py-2.5 text-start text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
            >
              <ExternalLink className="w-4 h-4" />
              {t.deployments.menu.openDeployment}
            </button>
          )}

          {deployment.owner && deployment.repo && (
            <button
              onClick={() => {
                window.open(`https://github.com/${deployment.owner}/${deployment.repo}`, "_blank");
                setIsOpen(false);
              }}
              className="w-full px-4 py-2.5 text-start text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
            >
              {generateIcon('https://upload.wikimedia.org/wikipedia/commons/9/91/Octicons-mark-github.svg', 16, 'currentColor', {}, true)}
              {t.deployments.menu.viewRepository}
            </button>
          )}

          <div className="h-px bg-border/50 my-2" />

          {deployment.domain && (
            <button
              onClick={() => {
                navigator.clipboard.writeText(`https://${deployment.domain}`);
                setIsOpen(false);
              }}
              className="w-full px-4 py-2.5 text-start text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
            >
              <Copy className="w-4 h-4" />
              {t.deployments.menu.copyDomainUrl}
            </button>
          )}

          <button
            onClick={() => {
              navigator.clipboard.writeText(deployment.id);
              setIsOpen(false);
            }}
            className="w-full px-4 py-2.5 text-start text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3"
          >
            <Copy className="w-4 h-4" />
            {t.deployments.menu.copyBuildId}
          </button>

          {isInFlight && (
            <>
              <div className="h-px bg-border/50 my-2" />
              <button
                onClick={handleCancel}
                className="w-full px-4 py-2.5 text-start text-sm text-danger hover:bg-danger-bg transition-colors flex items-center gap-3"
              >
                <XCircle className="w-4 h-4" />
                {t.deployments.menu.cancelDeployment}
              </button>
            </>
          )}

          {/* Restore this version. The API picks instant-from-artifact vs
              rebuild-from-commit, so this is enabled whenever EITHER is
              possible; the confirm dialog names the mode it resolved. */}
          {!isInFlight && deployment.status !== "building" && (
            <>
              <div className="h-px bg-border/50 my-2" />
              <button
                onClick={handleRollback}
                disabled={!canRollback}
                title={
                  canRollback
                    ? deployment.artifactRetainedAt
                      ? t.deployments.menu.rollbackTitle.enabled
                      : t.deployments.menu.rollbackTitle.rebuildOnly
                    : deployment.isActive
                      ? t.deployments.menu.rollbackTitle.active
                      : !hasCommit
                        ? t.deployments.menu.rollbackTitle.pruned
                        : t.deployments.menu.rollbackTitle.notReady
                }
                className="w-full px-4 py-2.5 text-start text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <RotateCcw className="w-4 h-4" />
                {t.deployments.menu.rollback}
              </button>
            </>
          )}

          {/* Pin / Unpin — toggles the artifact's exemption from retention
              prune. Successful deploys only: the API rejects a pin on anything
              but `ready`, so `partial_failure` is excluded even though it can be
              rolled back to. */}
          {!isInFlight && deployment.status === "success" && (
            <button
              onClick={handleTogglePin}
              disabled={!deployment.pinned && !deployment.artifactRetainedAt}
              title={
                deployment.pinned
                  ? t.deployments.menu.pinTitle.unpin
                  : !deployment.artifactRetainedAt
                    ? t.deployments.menu.pinTitle.pruned
                    : t.deployments.menu.pinTitle.pin
              }
              className="w-full px-4 py-2.5 text-start text-sm text-foreground/70 hover:bg-muted transition-colors flex items-center gap-3 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
            >
              {deployment.pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />}
              {deployment.pinned ? t.deployments.menu.unpin : t.deployments.menu.pin}
            </button>
          )}

          {!isInFlight && (
            <>
              <div className="h-px bg-border/50 my-2" />
              <button
                onClick={handleDelete}
                className="w-full px-4 py-2.5 text-start text-sm text-danger hover:bg-danger-bg transition-colors flex items-center gap-3"
              >
                <Trash2 className="w-4 h-4" />
                {t.deployments.menu.deleteDeployment}
              </button>
            </>
          )}
        </div>
      )}

      <RollbackConfirmDialog
        isOpen={!!confirmPlan}
        plan={confirmPlan?.plan ?? null}
        modeLine={modeLine}
        busy={rollbackBusy}
        onConfirm={confirmRollback}
        onClose={() => setConfirmPlan(null)}
      />
    </div>
  );
};

