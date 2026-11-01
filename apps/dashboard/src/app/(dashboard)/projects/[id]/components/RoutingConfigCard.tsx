"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import React, { useCallback, useEffect, useRef, useState } from "react";
import type { RoutingConfig } from "@repo/core";
import { getApiErrorMessage, projectsApi } from "@/lib/api";
import type { EdgeConfigReport } from "@/lib/api/projects";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import { RoutingConfigEditor } from "@/components/routing/RoutingConfigEditor";
import { Button } from "@/components/ui/button";

type Props = {
  id: string;
  initial: RoutingConfig | null | undefined;
  /** Project deployment target, independent of the dashboard hosting mode. */
  isCloudProject?: boolean;
  onSaved?: (cfg: RoutingConfig | null) => void;
};

/** A project switch remounts drafts and observations before any new fields render. */
export function RoutingConfigCard(props: Props) {
  return <ProjectRoutingEditor key={props.id} {...props} />;
}

function ProjectRoutingEditor({ id, initial, onSaved, isCloudProject = false }: Props) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const w = t.widgets.routing.configEditor;
  const [draft, setDraft] = useState<RoutingConfig | null>(initial ?? null);
  const [saving, setSaving] = useState(false);
  const [edge, setEdge] = useState<EdgeConfigReport | null>(null);
  const [edgeLoading, setEdgeLoading] = useState(false);
  const mounted = useRef(true);
  const dirty = useRef(false);
  const readGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readGeneration.current++;
    };
  }, []);
  useEffect(() => {
    if (!dirty.current) setDraft(initial ?? null);
  }, [initial]);

  // Explicit readback only: merely viewing these settings must not open SSH.
  const loadEdge = useCallback(async () => {
    if (isCloudProject) return;
    const generation = ++readGeneration.current;
    setEdgeLoading(true);
    try {
      const next = await projectsApi.getEdgeConfig(id);
      if (mounted.current && generation === readGeneration.current) setEdge(next);
    } catch (error) {
      observeCaughtError(
        error,
        "dashboard/app/(dashboard)/projects/[id]/components/RoutingConfigCard",
      );
      if (mounted.current && generation === readGeneration.current)
        setEdge({ reachable: false, saved: {}, hosts: [] });
    } finally {
      if (mounted.current && generation === readGeneration.current) setEdgeLoading(false);
    }
  }, [id, isCloudProject]);

  const save = async () => {
    const submitted = draft;
    setSaving(true);
    // A read started before saving cannot describe the configuration after it.
    readGeneration.current++;
    setEdgeLoading(false);
    try {
      await projectsApi.update(id, { routingConfig: submitted });
      invalidateProjectCaches(id);
      if (!mounted.current) return;
      dirty.current = false;
      setEdge(null);
      onSaved?.(submitted);
      showToast(
        t.projectSettings.routing.toast.updated,
        "success",
        t.projectSettings.routing.toast.title,
      );
    } catch (error) {
      if (mounted.current)
        showToast(
          getApiErrorMessage(error) || t.projectSettings.routing.toast.failed,
          "error",
          t.projectSettings.routing.toast.title,
        );
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  return (
    <section className="space-y-4" aria-label={w.title}>
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-2xl bg-card p-5">
        <div className="min-w-0">
          <h3 className="text-base font-medium text-foreground">{w.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{w.description}</p>
        </div>
        <Button type="button" onClick={save} disabled={saving}>
          {saving ? t.projectSettings.routing.saving : t.projectSettings.routing.save}
        </Button>
      </div>
      <RoutingConfigEditor
        value={draft}
        onChange={(next) => {
          dirty.current = true;
          setDraft(next);
        }}
        disabled={saving}
        showProxySettings={!isCloudProject}
        edgeConfig={isCloudProject ? null : edge}
        onRefreshEdgeConfig={isCloudProject ? undefined : loadEdge}
        edgeConfigLoading={edgeLoading || saving}
      />
      {isCloudProject && (
        <p className="rounded-2xl bg-card p-5 text-sm text-muted-foreground">
          {w.proxyCloudUnavailable}
        </p>
      )}
      <div className="flex justify-end">
        <Button type="button" onClick={save} disabled={saving}>
          {saving ? t.projectSettings.routing.saving : t.projectSettings.routing.save}
        </Button>
      </div>
    </section>
  );
}

export default RoutingConfigCard;
