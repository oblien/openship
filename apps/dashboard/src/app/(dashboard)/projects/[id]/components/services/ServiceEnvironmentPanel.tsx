"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { looksLikeSecretKey } from "@repo/core";
import type {
  ServiceEnvironment,
  ServiceEnvironmentReview,
  MergeServiceEnvVarsInput,
} from "@repo/contracts";
import Link from "next/link";
import EnvironmentVariables, {
  type EnvironmentVariableRow,
} from "@/components/import-project/EnvironmentVariables";
import type { EnvironmentVariableMeta } from "@/components/import-project/environment-resolution";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { getApiErrorMessage } from "@/lib/api/client";
import { servicesApi, type Service } from "@/lib/api/services";
import {
  comparableServiceEnvironment as comparable,
  serviceEnvironmentRows,
  serviceEnvironmentChanges,
} from "@/lib/service-environment-editor";
import { SharedEnvironmentReview } from "./SharedEnvironmentReview";

type Props = {
  projectId: string;
  service: Service;
  applying: boolean;
  operationBusy: boolean;
  onApply: () => Promise<void>;
  onDeploy?: () => void;
  deployLabel?: string;
  onDirtyChange: (dirty: boolean) => void;
};

/** Only deliberately changed values are saved; shared sources require review. */
export function ServiceEnvironmentPanel({
  projectId,
  service,
  applying,
  operationBusy,
  onApply,
  onDeploy,
  deployLabel,
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
  const [reviewing, setReviewing] = useState(false);
  const [review, setReview] = useState<{
    data: ServiceEnvironmentReview;
    input: MergeServiceEnvVarsInput;
  } | null>(null);
  const [alsoSaved, setAlsoSaved] = useState<Array<{ id: string; name: string }>>([]);
  const [recovering, setRecovering] = useState(false);
  const [allowRuntimeRemoval, setAllowRuntimeRemoval] = useState(false);
  const deletedKeys = useRef(new Set<string>());
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const alive = useRef(true);
  const mutation = useRef(false);

  const projectRows = useCallback(
    (value: ServiceEnvironment): EnvironmentVariableRow[] => serviceEnvironmentRows(value, labels),
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
    setReview(null);
    setAlsoSaved([]);
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
  const busy = saving || reviewing || !!review || recovering || operationBusy;
  const persist = async (input: MergeServiceEnvVarsInput) => {
    if (mutation.current) return;
    mutation.current = true;
    setSaving(true);
    // Invalidate an inspection started before these edits were saved.
    const token = ++generation.current;
    setChecking(false);
    try {
      const result = await servicesApi.mergeEnv(projectId, service.id, input);
      if (!result.success) throw new Error(copy.toast.envSaveFailed);
      if (!alive.current || token !== generation.current) return;
      setReview(null);
      setAlsoSaved((result.affectedServices ?? []).filter((item) => item.id !== service.id));
      deletedKeys.current = new Set(input.deletes.map((row) => row.key));
      setAllowRuntimeRemoval(false);
      showToast(copy.toast.envUpdated, "success", service.name);
      await load();
    } catch (cause) {
      if (alive.current && token === generation.current) {
        setReview(null);
        showToast(getApiErrorMessage(cause, copy.toast.envSaveFailed), "error", service.name);
      }
    } finally {
      mutation.current = false;
      if (alive.current) setSaving(false);
    }
  };

  const save = async () => {
    if (!state || mutation.current || busy || !dirty) return;
    const input = { environment: state.environment, ...serviceEnvironmentChanges(baseline, rows) };
    const inherited = input.upserts.some((edit) => state.variables.some((row) =>
      row.key === edit.key && (row.source === "project" || row.source === "compose"),
    ));
    if (inherited) {
      mutation.current = true;
      setReviewing(true);
      const token = generation.current;
      try {
        const data = await servicesApi.reviewEnv(projectId, service.id, input);
        if (!alive.current || token !== generation.current) return;
        if (data.changes.length) {
          setReview({ data, input });
          return;
        }
      } catch (cause) {
        if (alive.current && token === generation.current)
          showToast(getApiErrorMessage(cause, labels.shared.reviewFailed), "error", service.name);
        return;
      } finally {
        mutation.current = false;
        if (alive.current) setReviewing(false);
      }
    }
    await persist(input);
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
  const changedKeys = (state?.changedKeys ?? []).filter(
    (key) => !state?.recoverableKeys.includes(key),
  );

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
            {saving || reviewing ? <UiIcon name="spinner" className="animate-spin" /> : <UiIcon name="save" />}
            {t.projectSettings.settingSection.save}
          </Button>
          {state?.status === "not-deployed" && onDeploy && (
            <Button
              size="sm"
              disabled={dirty || busy || loading || checking || !service.enabled}
              title={dirty ? copy.environmentApply.saveFirst : undefined}
              onClick={onDeploy}
            >
              <UiIcon name="rocket" />
              {deployLabel ?? copy.redeploy}
            </Button>
          )}
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
        {alsoSaved.length > 0 && (
          <div role="status" className="space-y-1">
            <p>{labels.shared.saved}</p>
            <div className="flex flex-wrap gap-3">
              {alsoSaved.map((item) => (
                <Link
                  key={item.id}
                  className="text-foreground underline underline-offset-4"
                  href={`/projects/${projectId}/services/${item.id}/env`}
                >
                  {item.name}
                </Link>
              ))}
            </div>
          </div>
        )}
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
              {!checking && state.status === "pending" && changedKeys.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span>{labels.changedLabel}:</span>
                  {changedKeys.map((key) => (
                    <code
                      key={key}
                      className="rounded-md bg-muted/50 px-1.5 py-0.5 text-foreground"
                    >
                      {key}
                    </code>
                  ))}
                </div>
              )}
              {!checking && state.recoverableKeys.length > 0 && (
                <details className="rounded-xl bg-muted/30 px-3 py-2.5">
                  <summary className="cursor-pointer text-foreground">
                    {labels.recoveryTitle} · {state.recoverableKeys.length}
                  </summary>
                  <div className="mt-2 space-y-2">
                    <p>{labels.recoveryHint}</p>
                    <div className="flex flex-wrap gap-1.5">
                      {state.recoverableKeys.map((key) => (
                        <code key={key} className="rounded-md bg-muted/50 px-1.5 py-0.5">
                          {key}
                        </code>
                      ))}
                    </div>
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
                </details>
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
      {review && (
        <SharedEnvironmentReview
          review={review.data}
          serviceName={service.name}
          saving={saving}
          onClose={() => { if (!saving) setReview(null); }}
          onSave={(keys) => void persist({
            ...review.input,
            ...(keys.length ? { shared: { keys, revision: review.data.revision } } : {}),
          })}
        />
      )}
    </div>
  );
}
