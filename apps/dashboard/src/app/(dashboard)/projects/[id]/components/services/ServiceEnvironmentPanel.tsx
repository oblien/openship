"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { ENV_MASK, looksLikeSecretKey } from "@repo/core";
import type { MergeServiceEnvVarsInput, ServiceEnvironment } from "@repo/contracts";
import EnvironmentVariables, {
  type EnvironmentVariableRow,
} from "@/components/import-project/EnvironmentVariables";
import type { EnvironmentVariableMeta } from "@/components/import-project/environment-resolution";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { getApiErrorMessage } from "@/lib/api/client";
import { servicesApi, type Service } from "@/lib/api/services";

type Props = {
  projectId: string;
  service: Service;
  applying: boolean;
  operationBusy: boolean;
  onApply: () => Promise<void>;
  onDirtyChange: (dirty: boolean) => void;
};

const comparable = (rows: EnvironmentVariableRow[]) =>
  rows
    .filter((row) => row.key.trim())
    .map((row) => ({
      key: row.key.trim(),
      value: row.preserveValue ? ENV_MASK : row.value,
      isSecret: row.isSecret ?? looksLikeSecretKey(row.key),
      sourceId: row.sourceId ?? null,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));

/** The editor displays effective values but writes ONLY deliberately changed overrides. */
export function ServiceEnvironmentPanel({
  projectId,
  service,
  applying,
  operationBusy,
  onApply,
  onDirtyChange,
}: Props) {
  const { t } = useI18n();
  const copy = t.projectDetail.services.detail;
  const labels = copy.environmentState;
  const helpId = useId();
  const [helpOpen, setHelpOpen] = useState(false);
  const { showToast } = useToast();
  const [state, setState] = useState<ServiceEnvironment | null>(null);
  const [rows, setRows] = useState<EnvironmentVariableRow[]>([]);
  const [baseline, setBaseline] = useState<EnvironmentVariableRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const [allowRuntimeRemoval, setAllowRuntimeRemoval] = useState(false);
  const deletedKeys = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const mutation = useRef(false);

  const projectRows = useCallback(
    (value: ServiceEnvironment): EnvironmentVariableRow[] =>
      value.variables.map((row) => ({
        key: row.key,
        value: row.value,
        isSecret: row.isSecret,
        visible: !row.isSecret,
        sourceId: row.sourceId,
        originLabel: labels.sources[row.source],
        keyReadOnly: row.source !== "service",
        removalDisabled: row.source !== "service",
        removalLabel: row.source === "service" ? labels.removeOverride : labels.removeAtSource,
      })),
    [labels],
  );

  const checkRuntime = useCallback(
    async (environment: ServiceEnvironment["environment"], token = generation.current) => {
      setChecking(true);
      try {
        const result = await servicesApi.getEnvironment(projectId, service.id, {
          environment,
          inspectRuntime: true,
        });
        if (!result.success) throw new Error(labels.checkFailed);
        if (alive.current && token === generation.current) setState(result.environment);
      } catch (cause) {
        if (alive.current && token === generation.current)
          setState((previous) =>
            previous
              ? {
                  ...previous,
                  status: "unavailable",
                  changedKeys: [],
                  recoverableKeys: [],
                  message: getApiErrorMessage(cause, labels.checkFailed),
                }
              : previous,
          );
      } finally {
        if (alive.current && token === generation.current) setChecking(false);
      }
    },
    [projectId, service.id, labels.checkFailed],
  );

  const load = useCallback(async () => {
    const token = ++generation.current;
    setLoading(true);
    setError(null);
    try {
      const result = await servicesApi.getEnvironment(projectId, service.id);
      if (!result.success) throw new Error(labels.loadFailed);
      if (!alive.current || token !== generation.current) return;
      const next = projectRows(result.environment);
      setState(result.environment);
      setRows(next);
      setBaseline(next);
      void checkRuntime(result.environment.environment, token);
    } catch (cause) {
      if (alive.current && token === generation.current)
        setError(getApiErrorMessage(cause, labels.loadFailed));
    } finally {
      if (alive.current && token === generation.current) setLoading(false);
    }
  }, [projectId, service.id, projectRows, labels.loadFailed, checkRuntime]);

  useEffect(() => {
    alive.current = true;
    void load();
    return () => {
      alive.current = false;
      generation.current++;
    };
  }, [load]);

  const dirty = JSON.stringify(comparable(rows)) !== JSON.stringify(comparable(baseline));
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  const busy = saving || recovering || operationBusy;
  const save = async () => {
    if (!state || mutation.current || busy || !dirty) return;
    mutation.current = true;
    setSaving(true);
    // Invalidate an inspection started before these edits were saved.
    generation.current++;
    setChecking(false);
    try {
      const before = comparable(baseline);
      const after = comparable(rows);
      const deletes = before
        .filter((row) => row.sourceId && !after.some((next) => next.sourceId === row.sourceId))
        .map((row) => ({ key: row.key, sourceId: row.sourceId! }));
      const upserts: MergeServiceEnvVarsInput["upserts"] = after.filter((row) => {
        const old = row.sourceId
          ? before.find((item) => item.sourceId === row.sourceId)
          : before.find((item) => item.key === row.key);
        return (
          !old || old.key !== row.key || old.value !== row.value || old.isSecret !== row.isSecret
        );
      });
      const result = await servicesApi.mergeEnv(projectId, service.id, {
        environment: state.environment,
        upserts,
        deletes,
      });
      if (!result.success) throw new Error(copy.toast.envSaveFailed);
      if (!alive.current) return;
      deletedKeys.current = new Set(deletes.map((row) => row.key));
      setAllowRuntimeRemoval(false);
      showToast(copy.toast.envUpdated, "success", service.name);
      await load();
    } catch (cause) {
      if (alive.current)
        showToast(getApiErrorMessage(cause, copy.toast.envSaveFailed), "error", service.name);
    } finally {
      mutation.current = false;
      if (alive.current) setSaving(false);
    }
  };

  const recover = async () => {
    if (!state?.containerId || !state.recoverableKeys.length || mutation.current || busy) return;
    mutation.current = true;
    setRecovering(true);
    try {
      const result = await servicesApi.revealEnv(
        projectId,
        service.id,
        state.recoverableKeys,
        state.environment,
        { source: "runtime", containerId: state.containerId },
      );
      if (!result.success) throw new Error(labels.recoveryFailed);
      if (!alive.current) return;
      setRows((current) => [
        ...current,
        ...Object.entries(result.environment)
          .filter(([key]) => !current.some((row) => row.key === key))
          .map(([key, value]) => ({
            key,
            value,
            isSecret: true,
            visible: false,
            originLabel: labels.recovered,
          })),
      ]);
      showToast(labels.recoveredHint, "info", service.name);
    } catch (cause) {
      if (alive.current)
        showToast(getApiErrorMessage(cause, labels.recoveryFailed), "error", service.name);
    } finally {
      mutation.current = false;
      if (alive.current) setRecovering(false);
    }
  };

  const metadata = useMemo(
    () =>
      Object.fromEntries(
        (state?.variables ?? [])
          .filter((row) => row.missing)
          .map((row) => [
            row.key,
            {
              source: "missing",
              required: true,
              resolvedValue: "",
              variable: row.key,
            } satisfies EnvironmentVariableMeta,
          ]),
      ),
    [state],
  );
  const applyHint = !service.enabled
    ? copy.toast.enableBeforeRedeploy
    : dirty
      ? copy.environmentApply.saveFirst
      : copy.environmentApply.hint;
  const unreviewedRuntimeKeys = (state?.recoverableKeys ?? []).filter(
    (key) => !deletedKeys.current.has(key),
  );
  const needsRecoveryReview = unreviewedRuntimeKeys.length > 0 && !allowRuntimeRemoval;

  return (
    <div className="bg-card rounded-2xl border border-border/50">
      <div className="flex flex-wrap items-center gap-3 border-b border-border/50 px-5 py-3">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-medium text-foreground">
            {t.importProject.environmentVariables.title}
          </h3>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            aria-label={labels.helpTitle}
            title={labels.helpTitle}
            aria-expanded={helpOpen}
            aria-controls={helpId}
            onClick={() => setHelpOpen((open) => !open)}
          >
            <UiIcon name="info" className="size-4" />
          </Button>
        </div>
        <div className="ms-auto flex max-w-full flex-wrap items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void save()}
            aria-label={copy.saveEnvironment}
            disabled={loading || !!error || busy || !dirty}
          >
            {saving ? <UiIcon name="spinner" className="animate-spin" /> : <UiIcon name="save" />}
            {t.projectSettings.settingSection.save}
          </Button>
          {(state?.status === "pending" || applying || dirty) && (
            <Button
              size="sm"
              title={needsRecoveryReview ? labels.recoveryHint : applyHint}
              disabled={
                !service.enabled ||
                state?.status !== "pending" ||
                checking ||
                loading ||
                !!error ||
                busy ||
                dirty ||
                needsRecoveryReview
              }
              onClick={async () => {
                await onApply();
                if (alive.current) await load();
              }}
            >
              {applying ? <UiIcon name="spinner" className="animate-spin" /> : <UiIcon name="refresh" />}
              {applying ? copy.environmentApply.applying : copy.environmentApply.title}
            </Button>
          )}
        </div>
      </div>
      <div className="px-5 pt-4 text-xs text-muted-foreground space-y-2">
        <p id={helpId} hidden={!helpOpen}>{labels.description}</p>
        {loading ? (
          <p role="status">{labels.loading}</p>
        ) : error ? (
          <div role="alert">
            <p>{error}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {labels.reload}
            </Button>
          </div>
        ) : (
          state && (
            <>
              <div className="flex flex-wrap items-center gap-2" role="status">
                <span>
                  {checking ? labels.checking : (state.message ?? labels.status[state.status])}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={checking || busy}
                  onClick={() => void checkRuntime(state.environment)}
                >
                  {labels.check}
                </Button>
              </div>
              {!checking && state.status === "pending" && <p>{state.changedKeys.join(", ")}</p>}
              {!checking && state.recoverableKeys.length > 0 && (
                <div className="space-y-2">
                  <p>
                    {labels.recoveryHint} {state.recoverableKeys.join(", ")}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() => void recover()}
                  >
                    {recovering ? <UiIcon name="spinner" className="animate-spin" /> : null}
                    {labels.recover}
                  </Button>
                  {unreviewedRuntimeKeys.length > 0 && (
                    <label className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        checked={allowRuntimeRemoval}
                        disabled={busy || dirty}
                        onChange={(event) => setAllowRuntimeRemoval(event.target.checked)}
                      />
                      <span>{labels.removeRuntime}</span>
                    </label>
                  )}
                </div>
              )}
            </>
          )
        )}
      </div>
      {state && (
        <EnvironmentVariables
          mode="settings"
          hideTitle
          envVars={rows}
          envMeta={metadata}
          onEnvVarsChange={setRows}
          isEditingMode={!busy && !loading && !error}
          setIsEditingMode={() => {}}
          showSettingsActions={false}
          showSecretToggle
          borderless
          onReveal={async (keys) => {
            const response = await servicesApi.revealEnv(
              projectId,
              service.id,
              keys,
              state.environment,
              { source: "effective" },
            );
            if (!response.success) throw new Error(labels.loadFailed);
            return response.environment;
          }}
        />
      )}
    </div>
  );
}
