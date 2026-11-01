"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { getPortCheckIssue, getPortCheckTarget } from "@repo/core";
import { Icon as UiIcon } from "@repo/ui/icons";

import React, { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { projectsApi } from "@/lib/api/projects";
import { servicesApi } from "@/lib/api/services";
import { deployApi } from "@/lib/api/deploy";
import type { PortCheckUI, PublicEndpoint } from "@/context/deployment/types";
import type { Dictionary } from "@/i18n";

interface PortAdvisoryModalProps {
  deploymentId: string | null;
  projectId: string | null | undefined;
  checks: PortCheckUI[];
  skipped: (number | string)[];
  /** true = compose (change per-service exposedPort); false = single-app (change project port). */
  isCompose: boolean;
  /** Single-app: current public endpoints, so a port change updates the routed target too. */
  publicEndpoints?: PublicEndpoint[];
  onResolved: (deploymentId: string, target: number | string) => void;
}

/**
 * One review flow for exposed ports after a deployment is live. Missing
 * listeners keep the port editor; loopback binds need app/proxy configuration.
 * A failed dismissal must leave the warning visible and retryable.
 */
export function PortAdvisoryModal({
  deploymentId,
  projectId,
  checks,
  skipped,
  isCompose,
  publicEndpoints,
  onResolved,
}: PortAdvisoryModalProps) {
  const { t } = useI18n();
  const pa = t.importProject.deploymentProcessing.portAdvisory;
  const { showToast } = useToast();

  const [open, setOpen] = useState(false);
  const autoOpenedRef = useRef(false);

  const advisories = useMemo(
    () =>
      checks.filter(
        (c) => getPortCheckIssue(c) !== null && !skipped.includes(getPortCheckTarget(c, isCompose)),
      ),
    [checks, skipped, isCompose],
  );
  const hasLoopback = advisories.some((check) => getPortCheckIssue(check) === "loopback-only");

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
        <span className="flex-1 text-sm font-medium text-warning">
          {hasLoopback ? pa.loopbackTitle : pa.bannerTitle}
        </span>
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
              <h2 className="text-base font-semibold text-foreground">
                {hasLoopback ? pa.loopbackTitle : pa.title}
              </h2>
              <p className="mt-1 text-xs text-muted-foreground">
                {hasLoopback ? pa.loopbackNote : pa.note}
              </p>
            </div>
          </div>

          <div className="flex flex-col gap-3">
            {advisories.map((check) => (
              <AdvisoryRow
                key={`${getPortCheckTarget(check, isCompose)}:${check.port}`}
                check={check}
                isCompose={isCompose}
                strings={pa}
                canSkip={!!deploymentId}
                settingsHref={
                  projectId
                    ? isCompose && check.serviceId
                      ? `/projects/${projectId}/services/${check.serviceId}`
                      : `/projects/${projectId}/advanced`
                    : undefined
                }
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
                    if (deploymentId)
                      onResolved(deploymentId, getPortCheckTarget(check, isCompose));
                    showToast(interpolate(pa.applied, { port: String(newPort) }), "success");
                  } catch (diagnosticFailure) {
                    observeCaughtError(diagnosticFailure, "dashboard/components/import-project/PortAdvisoryModal");
                    showToast(pa.changeError, "error");
                  }
                }}
                onSkip={async () => {
                  if (!deploymentId) return;
                  try {
                    const target = getPortCheckTarget(check, isCompose);
                    const result = await deployApi.skipPortCheck(deploymentId, target);
                    if (!result.success) throw new Error("Port review dismissal was not saved");
                    onResolved(deploymentId, target);
                  } catch (diagnosticFailure) {
                    observeCaughtError(
                      diagnosticFailure,
                      "dashboard/components/import-project/PortAdvisoryModal",
                    );
                    showToast(pa.skipError, "error");
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
  strings: Dictionary["importProject"]["deploymentProcessing"]["portAdvisory"];
  canSkip: boolean;
  settingsHref?: string;
  onChangePort: (newPort: number) => Promise<void>;
  onSkip: () => Promise<void>;
}

function AdvisoryRow({
  check,
  isCompose,
  strings,
  canSkip,
  settingsHref,
  onChangePort,
  onSkip,
}: AdvisoryRowProps) {
  const [value, setValue] = useState(String(check.port));
  const [busy, setBusy] = useState<"change" | "skip" | null>(null);
  const loopbackOnly = getPortCheckIssue(check) === "loopback-only";

  const message =
    isCompose && check.serviceName
      ? interpolate(loopbackOnly ? strings.loopbackBodyService : strings.bodyService, {
          service: check.serviceName,
          port: String(check.port),
        })
      : interpolate(loopbackOnly ? strings.loopbackBody : strings.body, {
          port: String(check.port),
        });

  const newPort = Number(value);
  const canApply = Number.isInteger(newPort) && newPort > 0 && newPort <= 65535 && !busy;

  return (
    <div className="rounded-xl bg-card p-4">
      <p className="text-sm text-foreground">{message}</p>
      {loopbackOnly && <p className="mt-2 text-xs text-muted-foreground">{strings.loopbackHelp}</p>}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        {!loopbackOnly && (
          <label className="min-w-28 flex-1">
            <span className="mb-1 block text-xs text-muted-foreground">{strings.newPortLabel}</span>
            <Input
              variant="filled"
              className="h-10"
              type="number"
              inputMode="numeric"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        )}
        {!loopbackOnly && (
          <Button
            type="button"
            disabled={!canApply}
            onClick={async () => {
              setBusy("change");
              try {
                await onChangePort(newPort);
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === "change" ? (
              <UiIcon name="spinner" className="size-4 animate-spin" />
            ) : (
              <UiIcon name="arrow-right" className="size-4" />
            )}
            {strings.changePort}
          </Button>
        )}
        {loopbackOnly && settingsHref && (
          <Button asChild variant="secondary">
            <Link href={settingsHref}>{strings.openSettings}</Link>
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          disabled={!!busy || !canSkip}
          aria-busy={busy === "skip"}
          onClick={async () => {
            setBusy("skip");
            try {
              await onSkip();
            } finally {
              setBusy(null);
            }
          }}
        >
          {busy === "skip" && <UiIcon name="spinner" className="size-4 animate-spin" />}
          {strings.skip}
        </Button>
      </div>
    </div>
  );
}
