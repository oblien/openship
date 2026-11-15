"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { normalizeRepoPath, resolveWorkload } from "@repo/core";
import { RuntimeSourceUpdate } from "@/components/updates/RuntimeSourceUpdate";
import BuildSettingsFields from "@/components/import-project/BuildSettings";
import { CommandEnvironmentNotice } from "@/components/import-project/CommandEnvironmentNotice";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useToast } from "@/context/ToastContext";
import { projectsApi, type ProjectOptionsBody } from "@/lib/api/projects";
import { getApiErrorMessage } from "@/lib/api/client";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";

type Config = ReturnType<typeof useProjectSettings>["projectData"];

/** Only fields owned by the shared build form. Environment, routes and source identity
 * have their own owners and must never be serialized by a configuration save. */
function optionsOf(config: Config): ProjectOptionsBody {
  const options = config.options ?? {};
  return {
    installCommand: options.installCommand ?? "",
    buildCommand: options.buildCommand ?? "",
    startCommand: options.startCommand ?? "",
    outputDirectory: options.outputDirectory ?? "",
    productionPaths: options.productionPaths ?? "",
    rootDirectory: options.rootDirectory ?? "",
    productionPort: options.productionPort ? Number(options.productionPort) : undefined,
    hasBuild: options.hasBuild,
    hasServer: options.hasServer,
    workloadType: options.workloadType,
    buildImage: config.buildImage ?? "",
    runtimeVersion: config.runtimeVersion ?? null,
    runtimeImage: config.runtimeImage ?? null,
  };
}

export function ApplicationSettingsForm({
  onBusyChange,
}: {
  onBusyChange?: (busy: boolean) => void;
}) {
  const { id, projectData, buildData, updateProjectData, updateBuild, refreshEnvironment } =
    useProjectSettings();
  const { t } = useI18n();
  const copy = t.projectSettings.build.runtime;
  const { showToast } = useToast();
  const persisted = useMemo(
    () => ({ ...projectData, options: { ...projectData.options, ...buildData } }),
    [projectData, buildData],
  );
  const [baseline, setBaseline] = useState<Config>(persisted);
  const [draft, setDraft] = useState<Config>(persisted);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = useRef(false);
  const alive = useRef(true);
  const before = optionsOf(baseline);
  const after = optionsOf(draft);
  const patch = Object.fromEntries(
    Object.entries(after).filter(
      ([key, value]) => value !== before[key as keyof ProjectOptionsBody],
    ),
  ) as ProjectOptionsBody;
  const dirty = Object.keys(patch).length > 0;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange?.(saving);
  }, [saving, onBusyChange]);
  useEffect(() => {
    // A status refresh or an added companion must not erase an unsaved app draft.
    if (!dirty && !mutation.current) {
      setBaseline(persisted);
      setDraft(persisted);
    }
  }, [persisted, dirty]);
  useEffect(() => {
    if (!dirty) return;
    const prevent = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", prevent);
    return () => window.removeEventListener("beforeunload", prevent);
  }, [dirty]);

  const save = async () => {
    if (mutation.current || !dirty || buildData.isLoading || buildData.error) return;
    if (
      Object.hasOwn(patch, "productionPort") &&
      (!Number.isInteger(patch.productionPort) ||
        patch.productionPort! < 1 ||
        patch.productionPort! > 65535)
    ) {
      setError(copy.invalidPort);
      return;
    }
    mutation.current = true;
    setSaving(true);
    setError(null);
    try {
      const result = await projectsApi.setOptions(id, patch);
      if (result.success === false) throw new Error(copy.saveFailed);
      if (!alive.current) return;
      // setOptions returns the flat Project contract; the page uses the nested
      // ProjectDetails projection. Map only this form's options, retaining the
      // server's normalized workload, images and commands.
      const saved = result.data as Config;
      if (!saved || saved.id !== id) throw new Error(copy.saveFailed);
      const workload = resolveWorkload(saved.workloadType, saved.hasServer);
      const options = Object.fromEntries(
        Object.entries(after)
          .filter(([key]) => !["buildImage", "runtimeVersion", "runtimeImage"].includes(key))
          .map(([key, fallback]) => [
            key,
            key === "productionPort"
              ? workload === "web"
                ? String(saved.port ?? 3000)
                : ""
              : key === "workloadType"
                ? workload
                : Object.hasOwn(saved, key)
                  ? (saved[key] ?? (typeof fallback === "string" ? "" : fallback))
                  : fallback,
          ]),
      );
      const normalized = { ...draft, ...saved, options: { ...draft.options, ...options } };
      updateProjectData(normalized);
      setBaseline(normalized);
      setDraft(normalized);
      invalidateProjectCaches(id);
      showToast(copy.saved, "success");
    } catch (cause) {
      if (alive.current) setError(getApiErrorMessage(cause, copy.saveFailed));
    } finally {
      mutation.current = false;
      if (alive.current) setSaving(false);
    }
  };

  return (
    <div className="space-y-5">
      {projectData.gitOwner &&
        projectData.gitRepo &&
        (projectData.buildKind === "dockerfile" || projectData.framework === "docker") && (
          <RuntimeSourceUpdate
            projectId={id}
            initialPath={
              normalizeRepoPath(
                [buildData.rootDirectory, "Dockerfile"].filter(Boolean).join("/"),
              ) || "Dockerfile"
            }
          />
        )}
      {!dirty && (
        <CommandEnvironmentNotice
          commands={buildData}
          projectId={id}
          onMigrated={async (commands) => {
            updateBuild(commands);
            await refreshEnvironment();
          }}
        />
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset
          disabled={saving || buildData.isLoading || !!buildData.error}
          className="min-w-0 space-y-4"
        >
          <BuildSettingsFields
            surface="settings"
            buildConfig={draft}
            updateConfig={(updates) => setDraft((previous) => ({ ...previous, ...updates }))}
            updateOptions={(updates) =>
              setDraft((previous) => ({
                ...previous,
                options: { ...previous.options, ...updates },
              }))
            }
          />
          {(error || buildData.error) && (
            <p role="alert" className="text-sm text-danger">
              {error || buildData.error}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={!dirty}
              onClick={() => {
                setDraft(baseline);
                setError(null);
              }}
            >
              {t.projectSettings.settingSection.cancel}
            </Button>
            <Button type="submit" disabled={!dirty || saving}>
              <Icon
                name={saving ? "spinner" : "save"}
                className={saving ? "animate-spin" : undefined}
              />
              {t.projectSettings.settingSection.save}
            </Button>
          </div>
        </fieldset>
      </form>
      <p className="text-xs text-muted-foreground">
        {copy.projectSettingsHint}{" "}
        <Link
          href={`/projects/${id}/advanced`}
          className="text-foreground underline underline-offset-4"
        >
          {t.projects.sidebar.tabs.settings}
        </Link>
      </p>
    </div>
  );
}
