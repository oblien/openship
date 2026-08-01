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
import { deployApi, getApiErrorMessage } from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface Deployment {
  id: string;
  status: string;
  domain: string;
  owner?: string;
  repo?: string;
  commit: {
    hash: string;
    /** Full SHA when known — required by "Redeploy this commit". */
    fullHash?: string | null;
  };
  /** Rollback state — flows from the orchestrator-aware listing endpoint. */
  artifactRetainedAt?: string | null;
  pinned?: boolean;
  isActive?: boolean;
}

interface DeploymentMenuProps {
  deployment: Deployment;
  triggerClassName?: string;
  onStatusChange?: () => void;
}

export const DeploymentMenu: React.FC<DeploymentMenuProps> = ({
  deployment,
  triggerClassName,
  onStatusChange,
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
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
    (deployment.status === "ready" || deployment.status === "partial_failure") &&
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
    // "instant" or "rebuild" truthfully instead of guessing from a DB flag.
    const plan = await deployApi
      .restorePlan(deployment.id)
      .then((res) => res.data)
      .catch(() => null);
    const modeLine =
      plan?.mode === "rebuild"
        ? t.deployments.menu.rollbackModeRebuild
        : plan?.mode === "redeploy-pinned" && plan.rebuildServices.length > 0
          ? interpolate(t.deployments.menu.rollbackModeMixed, {
              count: String(plan.rebuildServices.length),
            })
          : plan
            ? t.deployments.menu.rollbackModeInstant
            : "";
    const ok = window.confirm(
      [modeLine, t.deployments.menu.confirmRollback].filter(Boolean).join("\n\n"),
    );
    if (!ok) return;
    try {
      await deployApi.rollback(deployment.id);
      onStatusChange?.();
    } catch (err) {
      window.alert(getApiErrorMessage(err, t.deployments.menu.rollbackFailed));
    }
  };

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

          {/* Pin / Unpin — toggles the artifact's exemption from
              retention prune. Available for any ready deployment. */}
          {!isInFlight && deployment.status === "ready" && (
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
    </div>
  );
};

