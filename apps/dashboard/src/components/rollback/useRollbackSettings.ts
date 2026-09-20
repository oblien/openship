"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeRollbackWindow } from "@repo/core";
import { projectsApi, getApiErrorMessage } from "@/lib/api";
import type { RollbackCapacityUI } from "@/lib/api/projects";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";

/** Shared persistence for Advanced settings and the existing-project wizard. */
export function useRollbackSettings(projectId?: string | null, enabled = true) {
  const { t } = useI18n();
  const { showToast } = useToast();
  const identity = useRef(projectId);
  identity.current = projectId;
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const [state, setState] = useState<{
    projectId?: string | null;
    capacity: RollbackCapacityUI | null;
    error: string | null;
    loading: boolean;
  }>({ projectId, capacity: null, error: null, loading: true });
  const [saving, setSaving] = useState<"window" | "strategy" | null>(null);

  const reload = useCallback(async () => {
    if (!mounted.current || !projectId || identity.current !== projectId) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setState({ projectId, capacity: null, error: null, loading: true });
    try {
      const response = await projectsApi.getRollbackCapacity(projectId, controller.signal);
      if (!controller.signal.aborted && identity.current === projectId) {
        setState({ projectId, capacity: response.data, error: null, loading: false });
      }
    } catch (err) {
      if (!controller.signal.aborted && identity.current === projectId) {
        setState({ projectId, capacity: null, loading: false,
          error: getApiErrorMessage(err, t.projectSettings.git.rollbackHistory.loadFailed) });
      }
    }
  }, [projectId, t.projectSettings.git.rollbackHistory.loadFailed]);

  useEffect(() => {
    mounted.current = true;
    if (enabled) void reload();
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, [enabled, reload]);

  const capacity = state.projectId === projectId ? state.capacity : null;
  const save = async (kind: "window" | "strategy", patch: Record<string, unknown>) => {
    if (!projectId || !capacity || pending.current) return;
    pending.current = true;
    setSaving(kind);
    try {
      await projectsApi.update(projectId, patch);
      invalidateProjectCaches(projectId);
      await reload();
    } catch (err) {
      if (identity.current === projectId) {
        showToast(getApiErrorMessage(err, kind === "window"
          ? t.projectSettings.git.toast.rollbackHistoryFailed
          : t.projectSettings.git.toast.rollbackStrategyFailed), "error");
      }
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(null);
    }
  };

  return {
    capacity,
    error: state.projectId === projectId ? state.error : null,
    loading: state.projectId !== projectId || state.loading,
    savingWindow: saving === "window",
    togglingStrategy: saving === "strategy",
    reload,
    changeWindow: async (value: number) => {
      const next = normalizeRollbackWindow(value);
      if (capacity && next !== capacity.window) await save("window", { rollbackWindow: next });
    },
    toggleStrategy: () => save("strategy", {
      defaultRollbackStrategy: capacity?.strategy === "snapshot" ? "git" : "snapshot",
    }),
  };
}
