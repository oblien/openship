"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@repo/ui/icons";
import { EnvironmentPanel } from "./EnvironmentPanel";
import { RuntimeRedeployMenu } from "./RuntimeRedeployMenu";
import { RuntimeImageUpdateNotice } from "./RuntimeImageUpdateNotice";
import { AppLogo } from "@/components/AppLogo";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useToast } from "@/context/ToastContext";
import { useComposeReview } from "@/hooks/useComposeReview";
import { useCloudDeployPricing } from "@/hooks/useCloudDeployPricing";
import { useRuntimeUpdate } from "@/hooks/useRuntimeUpdate";
import { projectsApi, deployApi } from "@/lib/api";
import { connectionsApi, type ProjectConnection } from "@/lib/api/connections";
import { getApiErrorMessage } from "@/lib/api/client";
import { canRefreshProjectEnvironment } from "@/lib/project-application";
import { openTriggeredBuild, triggeredDeploymentId } from "@/lib/deploy-nav";
import {
  computeProjectEnvDiff,
  createProjectEnvEditState,
  type PersistedProjectEnv,
} from "@/lib/project-env-diff";
import type { EnvironmentVariableRow } from "@/components/import-project/EnvironmentVariables";

/** Project-scoped adapter for the same panel used by service environments.
 * A single application continues to own project variables; it gets no shadow service or env store.
 */
export function ProjectEnvironmentPanel({
  onBusyChange,
  onDirtyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { id: projectId, projectData, servicesData } = useProjectSettings();
  const { t } = useI18n();
  const copy = t.projectSettings.envVars;
  const serviceCopy = t.projectDetail.services.detail;
  const { showToast } = useToast();
  const router = useRouter();
  const showComposeReview = useComposeReview(projectId);
  const showCloudPricing = useCloudDeployPricing(projectData.workspaceId);
  const runtime = useRuntimeUpdate(
    projectId,
    undefined,
    projectData.workspaceId,
    projectData.activeDeploymentId,
  );
  const canRefresh = canRefreshProjectEnvironment(projectData, servicesData.services);
  const shared = servicesData.services.some(service => !service.applicationMode);
  const [rows, setRows] = useState<EnvironmentVariableRow[]>([]);
  const [baseline, setBaseline] = useState<PersistedProjectEnv[] | null>(null);
  const [connections, setConnections] = useState<ProjectConnection[]>([]);
  const [selectedConnection, setSelectedConnection] = useState<ProjectConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<"save" | "apply" | "build" | "unlink" | null>(null);
  const [updateHref, setUpdateHref] = useState<string | null>(null);
  const generation = useRef(0);
  const mutation = useRef(false);
  const alive = useRef(true);
  const busy = operation !== null || runtime.updating || runtime.checking;
  const diff = baseline ? computeProjectEnvDiff(rows, baseline) : null;
  const dirty =
    !!diff && (!diff.ok || diff.diff.upserts.length > 0 || diff.diff.deletes.length > 0);
  const linkedKeys = new Set(connections.map((connection) => connection.envKey));
  const managedRows = rows.filter((row) => linkedKeys.has(row.originalKey ?? row.key));
  const editableRows = rows.filter((row) => !linkedKeys.has(row.originalKey ?? row.key));

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);

  const load = useCallback(async () => {
    const token = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      // Resolve ownership before enabling editing. A failed connection read must
      // not turn integration-managed variables into ordinary editable inputs.
      const [result, linked] = await Promise.all([
        projectsApi.getEnv(projectId),
        connectionsApi.list(projectId),
      ]);
      if (!alive.current || token !== generation.current) return;
      const state = createProjectEnvEditState(result.data ?? [], "production");
      setRows(state.rows);
      setBaseline(state.baseline);
      setConnections(linked.data ?? []);
    } catch (cause) {
      if (alive.current && token === generation.current)
        setError(getApiErrorMessage(cause, copy.toast.loadFailed));
    } finally {
      if (alive.current && token === generation.current) setLoading(false);
    }
  }, [projectId, copy.toast.loadFailed]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [load]);

  const save = async () => {
    if (mutation.current || busy || loading || error || !diff || !dirty) return;
    if (!diff.ok) {
      showToast(diff.error, "error", copy.toast.validationTitle);
      return;
    }
    // Pasting a managed key cannot create an editable replacement for it.
    if (diff.diff.upserts.some((row) => linkedKeys.has(row.key))) {
      showToast(copy.linkedTitle, "error");
      return;
    }
    mutation.current = true;
    setOperation("save");
    try {
      const result = await projectsApi.mergeEnv(projectId, {
        environment: "production",
        ...diff.diff,
      });
      if (!alive.current) return;
      showToast(copy.toast.saved, "success", copy.toast.savedTitle);
      for (const warning of result.warnings ?? []) showToast(warning, "info");
      setUpdateHref(null);
      await load();
    } catch (cause) {
      if (alive.current)
        showToast(
          getApiErrorMessage(cause, copy.toast.saveFailed),
          "error",
          copy.toast.saveFailedTitle,
        );
    } finally {
      mutation.current = false;
      if (alive.current) setOperation(null);
    }
  };

  const deploy = async (refresh: boolean) => {
    if (mutation.current || busy || loading || error || dirty || !baseline) return;
    mutation.current = true;
    setOperation(refresh ? "apply" : "build");
    try {
      const result = await deployApi.trigger(
        refresh ? { projectId, refresh: true } : { projectId, smartRoute: true },
      );
      if (!alive.current) return;
      if (refresh) {
        // This API queues a deployment. Show its progress, never claim the
        // running environment already matches just because the request succeeded.
        const deploymentId = triggeredDeploymentId(result);
        setUpdateHref(
          deploymentId ? `/build/${deploymentId}` : `/projects/${projectId}/deployments`,
        );
        showToast(copy.updateStarted, "info");
      } else openTriggeredBuild(router, result, projectId);
    } catch (cause) {
      if (alive.current && !showComposeReview(cause) && !showCloudPricing(cause)) {
        showToast(
          getApiErrorMessage(
            cause,
            refresh ? copy.toast.applyFailed : t.projects.redeploy.couldNotRedeploy,
          ),
          "error",
          refresh ? copy.toast.applyFailedTitle : t.projects.redeploy.errorTitle,
        );
      }
    } finally {
      mutation.current = false;
      if (alive.current) setOperation(null);
    }
  };

  const unlink = async () => {
    if (!selectedConnection || mutation.current || busy || dirty) return;
    mutation.current = true;
    setOperation("unlink");
    try {
      await connectionsApi.remove(projectId, selectedConnection.id);
      if (!alive.current) return;
      setSelectedConnection(null);
      showToast(t.projects.connections.removed, "success");
      await load();
    } catch (cause) {
      if (alive.current)
        showToast(getApiErrorMessage(cause, t.projects.connections.failed), "error");
    } finally {
      mutation.current = false;
      if (alive.current) setOperation(null);
    }
  };

  const actionDisabled =
    loading ||
    !!error ||
    busy ||
    dirty ||
    !baseline ||
    servicesData.isLoading ||
    !!servicesData.error;
  return (
    <>
      <EnvironmentPanel
        description={t.projectSettings.build.env.description}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              disabled={loading || busy || dirty}
              title={copy.reload}
              aria-label={copy.reload}
              onClick={() => void load()}
            >
              <Icon name="refresh" className={loading ? "animate-spin" : undefined} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              aria-label={serviceCopy.saveEnvironment}
              disabled={loading || !!error || busy || !dirty}
              onClick={() => void save()}
            >
              <Icon
                name={operation === "save" ? "spinner" : "save"}
                className={operation === "save" ? "animate-spin" : undefined}
              />
              {t.projectSettings.settingSection.save}
            </Button>
            {projectData.activeDeploymentId && (
              <>
                <Button
                  variant={canRefresh ? "secondary" : "default"}
                  size="sm"
                  disabled={actionDisabled}
                  title={dirty ? serviceCopy.environmentApply.saveFirst : copy.buildHint}
                  onClick={() => void deploy(false)}
                >
                  <Icon
                    name={operation === "build" ? "spinner" : "rocket"}
                    className={operation === "build" ? "animate-spin" : undefined}
                  />
                  {copy.rebuildTitle}
                </Button>
                {(projectData.runtimeMode !== "bare" || shared) && (
                  <RuntimeRedeployMenu runtime={runtime} disabled={actionDisabled} />
                )}
                {canRefresh && (
                  <Button
                    size="sm"
                    disabled={actionDisabled}
                    title={dirty ? serviceCopy.environmentApply.saveFirst : copy.runtimeHint}
                    onClick={() => void deploy(true)}
                  >
                    <Icon
                      name={operation === "apply" ? "spinner" : "refresh"}
                      className={operation === "apply" ? "animate-spin" : undefined}
                    />
                    {operation === "apply"
                      ? serviceCopy.environmentApply.applying
                      : shared
                        ? copy.applyProject
                        : serviceCopy.environmentApply.title}
                  </Button>
                )}
              </>
            )}
          </>
        }
        editor={
          baseline && !loading && !error
            ? {
                envVars: editableRows,
                onEnvVarsChange: (next) => {
                  if (!mutation.current && !busy) setRows([...managedRows, ...next]);
                },
                isEditingMode: !busy,
                setIsEditingMode: () => {},
                isSaving: busy,
              }
            : undefined
        }
      >
        {shared && <p>{copy.sharedHint}</p>}
        {loading ? (
          <div
            className="space-y-3 pb-5 motion-safe:animate-pulse"
            aria-busy="true"
            aria-label={serviceCopy.environmentState.loading}
          >
            {[0, 1, 2].map((index) => (
              <div key={index} className="h-10 rounded-lg bg-muted" />
            ))}
          </div>
        ) : error ? (
          <div role="alert" className="space-y-2 pb-5">
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {serviceCopy.environmentState.reload}
            </Button>
          </div>
        ) : (
          <>
            <p>
              {!projectData.activeDeploymentId
                ? copy.firstDeployHint
                : canRefresh
                  ? copy.runtimeHint
                  : copy.buildHint}
            </p>
            <RuntimeImageUpdateNotice
              result={runtime.checkResult}
              busy={busy || dirty}
              onRefresh={runtime.update}
            />
            {updateHref && (
              <div role="status" className="flex flex-wrap items-center gap-2">
                <span>{copy.updateStarted}</span>
                <Link href={updateHref} className="text-foreground underline underline-offset-4">
                  {t.projects.sidebar.tabs.deployments}
                </Link>
              </div>
            )}
            {managedRows.map((row) => {
              const connection = connections.find((item) => item.envKey === row.key)!;
              return (
                <button
                  key={row.key}
                  type="button"
                  disabled={busy}
                  className="flex w-full items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-start"
                  onClick={() => setSelectedConnection(connection)}
                >
                  <AppLogo
                    appId={connection.sourceAppTemplateId ?? undefined}
                    className="size-4 shrink-0"
                  />
                  <code className="min-w-0 flex-1 truncate text-foreground">{row.key}</code>
                  <span>{interpolate(copy.linkedManaged, { app: connection.sourceName })}</span>
                  <Icon name="chevron-right" className="size-4" />
                </button>
              );
            })}
          </>
        )}
      </EnvironmentPanel>
      {selectedConnection && (
        <Modal
          isOpen
          onClose={() => {
            if (!busy) setSelectedConnection(null);
          }}
          closable={!busy}
          maxWidth="460px"
          width="92vw"
          zIndex={10010}
        >
          <div className="space-y-4 p-6">
            <h3 className="pe-8 text-base font-medium">{copy.linkedTitle}</h3>
            <code className="block break-all text-sm">{selectedConnection.envKey}</code>
            <p className="text-sm text-muted-foreground">
              {interpolate(copy.linkedBody, { app: selectedConnection.sourceName })}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => setSelectedConnection(null)}>
                {copy.close}
              </Button>
              <Button
                variant="destructive"
                disabled={busy || dirty}
                title={dirty ? serviceCopy.environmentApply.saveFirst : undefined}
                onClick={() => void unlink()}
              >
                {copy.unlink}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
