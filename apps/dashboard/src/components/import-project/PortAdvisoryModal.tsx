"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { projectsApi } from "@/lib/api/projects";
import { servicesApi } from "@/lib/api/services";
import { deployApi } from "@/lib/api/deploy";
import type { PortCheckUI, PublicEndpoint } from "@/context/deployment/types";

interface PortAdvisoryModalProps {
  deploymentId: string | null;
  projectId: string | null | undefined;
  checks: PortCheckUI[];
  skipped: (number | string)[];
  /** true = compose (change per-service exposedPort); false = single-app (change project port). */
  isCompose: boolean;
  /** Single-app: current public endpoints, so a port change updates the routed target too. */
  publicEndpoints?: PublicEndpoint[];
}

/** A stable local key for a check (so resolving one closes just that advisory). */
function keyOf(check: PortCheckUI, isCompose: boolean): string {
  return isCompose && check.serviceId ? `svc:${check.serviceId}` : `port:${check.port}`;
}

/** The value persisted to `meta.portCheckSkipped` — service id for compose, port for single-app. */
function skipTarget(check: PortCheckUI, isCompose: boolean): number | string {
  return isCompose && check.serviceId ? check.serviceId : check.port;
}

/**
 * Advisory "nothing is responding on port X — is that the right port?" modal.
 * Rendered on the build page after a deploy is live. Renders nothing unless a
 * probe conclusively found a non-listening exposed port. Change-port re-applies
 * routing live (no redeploy); Skip dismisses + persists so it won't re-nag.
 */
export function PortAdvisoryModal({
  deploymentId,
  projectId,
  checks,
  skipped,
  isCompose,
  publicEndpoints,
}: PortAdvisoryModalProps) {
  const { t } = useI18n();
  const pa = t.importProject.deploymentProcessing.portAdvisory;
  const { showToast } = useToast();

  // Advisories the user has changed/skipped this session — dismissed immediately
  // without waiting for a refetch.
  const [resolvedKeys, setResolvedKeys] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const autoOpenedRef = useRef(false);

  const advisories = useMemo(
    () =>
      checks.filter(
        (c) =>
          c.checked &&
          !c.listening &&
          !skipped.includes(skipTarget(c, isCompose)) &&
          !resolvedKeys.includes(keyOf(c, isCompose)),
      ),
    [checks, skipped, resolvedKeys, isCompose],
  );

  // Open once when an advisory first appears; the banner reopens it afterwards.
  useEffect(() => {
    if (advisories.length > 0 && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setOpen(true);
    }
  }, [advisories.length]);

  if (advisories.length === 0) return null;

  return (
    <>
      <div className="mt-4 flex items-center gap-3 rounded-xl border border-warning-border bg-warning-bg px-4 py-3">
        <UiIcon name="warning" className="size-4 shrink-0 text-warning" />
        <span className="flex-1 text-sm font-medium text-warning">{pa.bannerTitle}</span>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg bg-warning-bg px-3 py-1.5 text-xs font-medium text-warning transition-colors hover:bg-warning-bg"
        >
          {pa.review}
        </button>
      </div>

      <Modal isOpen={open} onClose={() => setOpen(false)} maxWidth="540px" width="100%">
        <div className="flex flex-col gap-4 p-6">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-warning-bg">
              <UiIcon name="warning" className="size-5 text-warning" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-foreground">{pa.title}</h2>
              <p className="mt-1 text-xs text-muted-foreground">{pa.note}</p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {advisories.map((check) => (
              <AdvisoryRow
                key={keyOf(check, isCompose)}
                check={check}
                isCompose={isCompose}
                strings={pa}
                onChangePort={async (newPort) => {
                  if (!projectId) return;
                  try {
                    if (isCompose && check.serviceId) {
                      await servicesApi.update(projectId, check.serviceId, {
                        exposedPort: String(newPort),
                      });
                    } else {
                      const endpoints = (publicEndpoints ?? []).map((ep) =>
                        ep.port === String(check.port) ? { ...ep, port: String(newPort) } : ep,
                      );
                      await projectsApi.update(projectId, {
                        port: newPort,
                        ...(endpoints.length > 0 ? { publicEndpoints: endpoints } : {}),
                      });
                    }
                    setResolvedKeys((r) => [...r, keyOf(check, isCompose)]);
                    showToast(interpolate(pa.applied, { port: String(newPort) }), "success");
                  } catch {
                    showToast(pa.changeError, "error");
                  }
                }}
                onSkip={() => {
                  setResolvedKeys((r) => [...r, keyOf(check, isCompose)]);
                  if (deploymentId) {
                    void deployApi.skipPortCheck(deploymentId, skipTarget(check, isCompose));
                  }
                }}
              />
            ))}
          </div>
        </div>
      </Modal>
    </>
  );
}

interface AdvisoryRowProps {
  check: PortCheckUI;
  isCompose: boolean;
  strings: {
    body: string;
    bodyService: string;
    newPortLabel: string;
    changePort: string;
    skip: string;
  };
  onChangePort: (newPort: number) => Promise<void>;
  onSkip: () => void;
}

function AdvisoryRow({ check, isCompose, strings, onChangePort, onSkip }: AdvisoryRowProps) {
  const [value, setValue] = useState(String(check.port));
  const [busy, setBusy] = useState(false);

  const message =
    isCompose && check.serviceName
      ? interpolate(strings.bodyService, { service: check.serviceName, port: String(check.port) })
      : interpolate(strings.body, { port: String(check.port) });

  const newPort = Number(value);
  const canApply = Number.isInteger(newPort) && newPort > 0 && newPort <= 65535 && !busy;

  return (
    <div className="rounded-xl border border-border/60 bg-muted/20 p-4">
      <p className="text-sm text-foreground">{message}</p>
      <div className="mt-3 flex items-end gap-2">
        <label className="flex-1">
          <span className="mb-1 block text-xs text-muted-foreground">{strings.newPortLabel}</span>
          <input
            type="number"
            inputMode="numeric"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="w-full rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </label>
        <button
          type="button"
          disabled={!canApply}
          onClick={async () => {
            setBusy(true);
            try {
              await onChangePort(newPort);
            } finally {
              setBusy(false);
            }
          }}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? <UiIcon name="spinner" className="size-4 animate-spin" /> : <UiIcon name="arrow-right" className="size-4" />}
          {strings.changePort}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onSkip}
          className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground disabled:opacity-50"
        >
          {strings.skip}
        </button>
      </div>
    </div>
  );
}
