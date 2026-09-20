"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Container, Github, Globe2, Loader2, Save } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useToast } from "@/context/ToastContext";
import { projectsApi } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { invalidateProjectCachesFor } from "@/hooks/useProjectEndpoints";
import { interpolate, useI18n } from "@/components/i18n-provider";
import {
  releaseImageDraftFromSource,
  releaseImageSourceFromDraft,
  releaseImageVersionLabels,
  type ReleaseImageSourceDraft,
} from "@/lib/release-image-source";

const inputClass =
  "mt-1.5 h-10 w-full rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-2 focus:ring-primary/10";

/**
 * Source settings for a non-catalog project that deploys a versioned registry
 * image. This deliberately replaces GitSettings: these projects have no clone,
 * branch, commit or push webhook, and showing those controls suggests a source
 * relationship that the deploy pipeline never uses.
 */
export function ReleaseImageSourceSettings({
  onCancel,
  onSwitchToGit,
}: {
  onCancel?: () => void;
  onSwitchToGit?: () => void;
}) {
  const { id, projectData, environments, updateProjectData } = useProjectSettings();
  const { showToast } = useToast();
  const { t } = useI18n();
  const copy = t.projectSettings.releaseImageSource;
  const source = projectData.releaseSource;
  const configured = source?.artifactKind === "image";
  const sourceDraft = useMemo(() => releaseImageDraftFromSource(source), [source]);
  const [draft, setDraft] = useState<ReleaseImageSourceDraft>(sourceDraft);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [releaseStatus, setReleaseStatus] = useState<{
    currentVersion?: string | null;
    latestVersion?: string | null;
    behind?: boolean;
  } | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const statusRequest = useRef(0);

  const loadReleaseStatus = useCallback(async () => {
    if (!configured) {
      setReleaseStatus(null);
      setStatusLoading(false);
      return;
    }
    const request = ++statusRequest.current;
    setStatusLoading(true);
    try {
      const result = await projectsApi.getCommitStatus(id);
      if (request !== statusRequest.current) return;
      setReleaseStatus(result.data?.mode === "release" ? result.data : null);
    } catch {
      if (request !== statusRequest.current) return;
      // Source editing remains available if the upstream version endpoint is
      // temporarily unavailable. The status rows say so without a noisy toast.
      setReleaseStatus(null);
    } finally {
      if (request === statusRequest.current) setStatusLoading(false);
    }
  }, [configured, id]);

  useEffect(() => {
    void loadReleaseStatus();
    return () => {
      statusRequest.current += 1;
    };
  }, [loadReleaseStatus]);

  useEffect(() => {
    setDraft(sourceDraft);
    setValidationError(null);
  }, [sourceDraft]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(sourceDraft);
  const set = <K extends keyof ReleaseImageSourceDraft>(
    key: K,
    value: ReleaseImageSourceDraft[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setValidationError(null);
  };

  const save = async () => {
    let payload;
    try {
      payload = releaseImageSourceFromDraft(draft);
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : copy.validationInvalid);
      return;
    }

    setSaving(true);
    try {
      const result = await projectsApi.setReleaseImageSource(id, payload);
      const saved = result.data.releaseSource ?? payload;
      updateProjectData({
        releaseSource: saved,
        gitProvider: "release",
        gitOwner: null,
        gitRepo: null,
        hasBuild: false,
        runtimeMode: "docker",
      });
      setDraft(releaseImageDraftFromSource(saved));
      invalidateProjectCachesFor([id, ...environments.map((environment) => environment.id)]);
      void loadReleaseStatus();
      showToast(copy.toast.saved, "success");
    } catch (error) {
      showToast(getApiErrorMessage(error, copy.toast.saveFailed), "error");
    } finally {
      setSaving(false);
    }
  };

  const versions = releaseImageVersionLabels({
    currentVersion: releaseStatus?.currentVersion,
    latestVersion: releaseStatus?.latestVersion,
    pinnedVersion: source?.pinnedVersion,
    loading: statusLoading,
    labels: copy.status,
  });
  const pinnedVersionField = (
    <label className="block text-xs font-medium text-foreground">
      {copy.editor.pinnedVersion}
      <input
        value={draft.pinnedVersion}
        onChange={(event) => set("pinnedVersion", event.target.value)}
        placeholder={copy.editor.pinnedPlaceholder}
        spellCheck={false}
        className={`${inputClass} font-mono`}
      />
      <span className="mt-1.5 block font-normal text-muted-foreground">
        {copy.editor.pinnedHint}
      </span>
    </label>
  );

  return (
    <div className="space-y-5">
      {!configured && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-warning-border bg-warning-bg px-5 py-4">
          <div>
            <p className="text-sm font-semibold text-foreground">{copy.switchToImage.title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{copy.switchToImage.description}</p>
          </div>
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-lg border border-border/60 bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/50"
            >
              {copy.switchToImage.keep}
            </button>
          )}
        </div>
      )}

      {configured && (
        <section className="overflow-hidden rounded-2xl border border-border/50 bg-card">
          <div className="flex items-start gap-3 border-b border-border/40 px-5 py-4">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Container className="size-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-semibold text-foreground">{copy.summary.title}</h3>
                <span className="rounded-full bg-success-bg px-2 py-0.5 text-[11px] font-medium text-success">
                  {copy.summary.badge}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">{copy.summary.description}</p>
            </div>
            {onSwitchToGit && (
              <button
                type="button"
                onClick={onSwitchToGit}
                className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border/60 bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted/50"
              >
                <Github className="size-3.5" />
                {copy.summary.linkGit}
              </button>
            )}
          </div>
          <dl className="divide-y divide-border/30 px-5">
            <StatusRow label={copy.summary.image} value={source?.imageTemplate ?? "—"} mono />
            <StatusRow
              label={copy.summary.versionSource}
              value={
                source?.mode === "github"
                  ? `${copy.summary.githubReleases} · ${source.repo ?? "—"}`
                  : source?.versionUrl || (source?.pinnedVersion ? copy.summary.pinnedVersion : "—")
              }
            />
            <StatusRow label={copy.summary.currentVersion} value={versions.current} mono />
            <StatusRow
              label={
                source?.pinnedVersion ? copy.summary.targetVersion : copy.summary.latestVersion
              }
              value={versions.latest}
              mono
              badge={releaseStatus?.behind ? copy.summary.updateAvailable : undefined}
            />
          </dl>
        </section>
      )}

      <section className="overflow-hidden rounded-2xl border border-border/50 bg-card">
        <div className="border-b border-border/40 px-5 py-4">
          <h3 className="text-sm font-semibold text-foreground">
            {configured ? copy.editor.trackingTitle : copy.editor.configureTitle}
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {interpolate(copy.editor.templateHint, { tag: "{tag}", version: "{version}" })}
          </p>
        </div>

        <div className="space-y-5 px-5 py-5">
          <div>
            <span className="text-xs font-medium text-foreground">{copy.editor.provider}</span>
            <div className="mt-2 grid gap-2 sm:grid-cols-2">
              <ModeButton
                active={draft.mode === "github"}
                icon={Github}
                title={copy.editor.githubTitle}
                description={copy.editor.githubDescription}
                onClick={() => set("mode", "github")}
              />
              <ModeButton
                active={draft.mode === "url"}
                icon={Globe2}
                title={copy.editor.urlTitle}
                description={copy.editor.urlDescription}
                onClick={() => set("mode", "url")}
              />
            </div>
          </div>

          <label className="block text-xs font-medium text-foreground">
            {copy.editor.imageTemplate}
            <input
              value={draft.imageTemplate}
              onChange={(event) => set("imageTemplate", event.target.value)}
              placeholder={copy.editor.imagePlaceholder}
              spellCheck={false}
              className={`${inputClass} font-mono`}
            />
          </label>

          {draft.mode === "github" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-medium text-foreground">
                {copy.editor.githubRepository}
                <input
                  value={draft.repo}
                  onChange={(event) => set("repo", event.target.value)}
                  placeholder={copy.editor.repoPlaceholder}
                  spellCheck={false}
                  className={`${inputClass} font-mono`}
                />
              </label>
              {pinnedVersionField}
            </div>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-xs font-medium text-foreground">
                {copy.editor.versionUrl}
                <input
                  type="url"
                  value={draft.versionUrl}
                  onChange={(event) => set("versionUrl", event.target.value)}
                  placeholder={copy.editor.versionUrlPlaceholder}
                  spellCheck={false}
                  className={inputClass}
                />
                <span className="mt-1.5 block font-normal text-muted-foreground">
                  {copy.editor.versionUrlHint}
                </span>
              </label>
              {pinnedVersionField}
            </div>
          )}

          {validationError && (
            <p
              role="alert"
              className="rounded-xl border border-danger-border bg-danger-bg px-3 py-2 text-xs text-danger"
            >
              {validationError}
            </p>
          )}

          <div className="flex items-center justify-between gap-3 border-t border-border/40 pt-4">
            <p className="text-xs text-muted-foreground">{copy.editor.appliesAll}</p>
            <button
              type="button"
              onClick={() => void save()}
              disabled={!dirty || saving}
              className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              {saving ? copy.editor.saving : copy.editor.save}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function StatusRow({
  label,
  value,
  mono = false,
  badge,
}: {
  label: string;
  value: string;
  mono?: boolean;
  badge?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 items-center justify-end gap-2 text-right">
        {badge && (
          <span className="shrink-0 rounded-full bg-warning-bg px-2 py-0.5 text-[11px] font-medium text-warning">
            {badge}
          </span>
        )}
        <span
          className={`break-all text-sm font-medium text-foreground ${mono ? "font-mono" : ""}`}
        >
          {value}
        </span>
      </dd>
    </div>
  );
}

function ModeButton({
  active,
  icon: Icon,
  title,
  description,
  onClick,
}: {
  active: boolean;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-colors ${
        active
          ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
          : "border-border/50 bg-background hover:bg-muted/30"
      }`}
    >
      <Icon
        className={`mt-0.5 size-4 shrink-0 ${active ? "text-primary" : "text-muted-foreground"}`}
      />
      <span>
        <span className="block text-sm font-medium text-foreground">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </button>
  );
}
