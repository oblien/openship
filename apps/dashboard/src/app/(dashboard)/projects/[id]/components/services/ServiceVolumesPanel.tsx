"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { servicesApi, type Service, type ServiceVolumeSizes } from "@/lib/api/services";
import { getApiErrorMessage } from "@/lib/api/client";
import { formatBytes } from "@/lib/formatBytes";
import { formatVolumeMount, parseVolumeMount, parseVolumeSpec, type VolumeMount } from "@repo/core";

export function ServiceVolumesPanel({
  service,
  projectId,
  deployTarget,
  onSave,
  onBackup,
  backupBusy,
  backupFeedback,
}: {
  service: Service;
  projectId: string;
  deployTarget?: string | null;
  onSave: (volumes: string[]) => Promise<void>;
  onBackup?: () => void;
  backupBusy?: boolean;
  backupFeedback?: ReactNode;
}) {
  const { t } = useI18n();
  const copy = t.projectDetail.services.detail.storage;
  const formId = useId();
  const mounts = service.volumes ?? [];
  const volumeKey = JSON.stringify(mounts);
  const [sizes, setSizes] = useState<ServiceVolumeSizes | null>(null);
  const [loading, setLoading] = useState(false);
  const [sizeError, setSizeError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<VolumeMount[]>([]);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Mounted only in Volumes. A failed measurement waits for an explicit retry;
  // request state is deliberately not an effect dependency.
  useEffect(() => {
    setSizes(null);
    setSizeError(false);
    setLoading(false);
    if (!JSON.parse(volumeKey).length || deployTarget === "cloud") return;
    let active = true;
    setLoading(true);
    servicesApi.volumeSizes(projectId, service.id)
      .then((result) => { if (active) setSizes(result); })
      .catch(() => { if (active) setSizeError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [projectId, service.id, volumeKey, deployTarget, revision]);

  const startEditing = () => {
    setDraft(mounts.length ? mounts.map(parseVolumeMount) : [parseVolumeMount("")]);
    setSaveError(null);
    setEditing(true);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    if (
      draft.some(
        (mount) =>
          !mount.target.trim().startsWith("/") ||
          mount.target.includes(":") ||
          mount.source.includes(":"),
      )
    ) {
      setSaveError(copy.invalidMount);
      return;
    }
    const volumes = draft.map(formatVolumeMount);
    if (volumes.some((volume) => volume.length > 500)) {
      setSaveError(copy.mountTooLong);
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(volumes);
      setEditing(false);
      setRevision((value) => value + 1);
    } catch (error) {
      setSaveError(getApiErrorMessage(error, t.projectDetail.services.detail.toast.updateFailed));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <h3 className="inline-flex items-center gap-2 text-sm font-semibold text-foreground">
            <UiIcon name="hard-drive" className="size-4 text-muted-foreground" />
            {t.projectDetail.services.detail.volumes}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">{copy.description}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onBackup && mounts.length > 0 && !editing && (
            <Button variant="outline" size="sm" disabled={backupBusy} onClick={onBackup}>
              {backupBusy ? (
                <UiIcon name="spinner" className="size-4 animate-spin" />
              ) : (
                <UiIcon name="database-backup" className="size-4" />
              )}
              {copy.backups}
            </Button>
          )}
          {!editing && (
            <Button variant="outline" size="sm" onClick={startEditing}>
              {mounts.length ? <UiIcon name="edit" className="size-4" /> : <UiIcon name="plus" className="size-4" />}
              {mounts.length ? copy.edit : copy.add}
            </Button>
          )}
        </div>
      </div>

      {editing ? (
        <form onSubmit={save} className="space-y-4 border-t border-border/40 p-5">
          <fieldset disabled={saving} className="space-y-3">
            {draft.map((mount, index) => {
              const label = interpolate(copy.mountLabel, { n: String(index + 1) });
              return (
                <div key={index} className="space-y-3 rounded-xl border border-border/50 p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{label}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={interpolate(copy.removeMount, { n: String(index + 1) })}
                      onClick={() => setDraft((current) => current.filter((_, i) => i !== index))}
                    >
                      <UiIcon name="trash" className="size-4" />
                    </Button>
                  </div>
                  <div className="grid gap-4 sm:grid-cols-2">
                    {(["source", "target"] as const).map((side) => {
                      const id = `${formId}-${index}-${side}`;
                      const fieldLabel = side === "source" ? copy.hostLabel : copy.serviceLabel;
                      return (
                        <div key={side} className="min-w-0 space-y-1.5">
                          <label htmlFor={id} className="block text-xs font-medium text-foreground">
                            {fieldLabel}
                          </label>
                          <input
                            id={id}
                            value={mount[side]}
                            maxLength={500}
                            aria-label={`${label}: ${fieldLabel}`}
                            aria-describedby={`${id}-hint`}
                            placeholder={side === "source" ? "/srv/app-data" : "/app/data"}
                            spellCheck={false}
                            autoComplete="off"
                            dir="ltr"
                            onChange={(event) =>
                              setDraft((current) =>
                                current.map((value, i) =>
                                  i === index ? { ...value, [side]: event.target.value } : value,
                                ),
                              )
                            }
                            className="h-10 w-full min-w-0 rounded-xl border border-border/50 bg-muted/20 px-3 font-mono text-sm text-foreground outline-none focus:border-primary/40"
                          />
                          <p
                            id={`${id}-hint`}
                            className="text-xs leading-relaxed text-muted-foreground"
                          >
                            {side === "source" ? copy.hostHint : copy.serviceHint}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={mount.options.includes("ro")}
                      aria-label={`${label}: ${copy.readOnly}`}
                      onChange={(event) =>
                        setDraft((current) =>
                          current.map((value, i) =>
                            i === index
                              ? {
                                  ...value,
                                  options: event.target.checked
                                    ? [
                                        ...value.options.filter(
                                          (option) => option !== "ro" && option !== "rw",
                                        ),
                                        "ro",
                                      ]
                                    : value.options.filter((option) => option !== "ro"),
                                }
                              : value,
                          ),
                        )
                      }
                    />
                    {copy.readOnly}
                  </label>
                </div>
              );
            })}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={draft.length >= 50}
              onClick={() => setDraft((current) => [...current, parseVolumeMount("")])}
            >
              <UiIcon name="plus" className="size-4" />
              {copy.add}
            </Button>
          </fieldset>
          <p className="text-xs leading-relaxed text-muted-foreground">{copy.editHint}</p>
          {saveError && (
            <p role="alert" className="text-sm text-danger">
              {saveError}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => setEditing(false)}
            >
              {copy.cancel}
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving && <UiIcon name="spinner" className="size-4 animate-spin" />}
              {copy.save}
            </Button>
          </div>
        </form>
      ) : mounts.length ? (
        <>
          <div className="flex items-center justify-between gap-3 border-y border-border/40 bg-muted/10 px-5 py-2.5">
            <span className="text-xs text-muted-foreground">{interpolate(copy.mountCount, { count: String(mounts.length) })}</span>
            <div className="flex items-center gap-2">
              <span aria-live="polite" className="text-xs tabular-nums text-muted-foreground">
                {loading ? copy.measuring : sizes?.measurable && sizes.totalBytes != null
                  ? `${sizes.partial ? "≥ " : ""}${formatBytes(sizes.totalBytes)}` : copy.usageUnavailable}
              </span>
              {deployTarget !== "cloud" && <Button variant="ghost" size="icon" className="size-7" disabled={loading}
                aria-label={copy.refresh} onClick={() => setRevision((value) => value + 1)}>
                <UiIcon name="refresh" className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
              </Button>}
            </div>
          </div>
          {sizeError && <p role="alert" className="px-5 pt-3 text-xs text-muted-foreground">{copy.measureFailed}</p>}
          <ul className="divide-y divide-border/40">
            {mounts.map((mount, index) => {
              const measured = sizes?.measurable
                ? sizes.volumes.find((volume) => volume.raw === mount)
                : undefined;
              const parsed = parseVolumeSpec(mount);
              return (
                <li
                  key={`${mount}-${index}`}
                  className="flex items-start justify-between gap-4 px-5 py-4"
                >
                  <div className="min-w-0 flex-1">
                    <dl className="grid gap-3 sm:grid-cols-2">
                      <div className="min-w-0">
                        <dt className="mb-1 text-xs text-muted-foreground">{copy.hostLabel}</dt>
                        <dd className="break-all font-mono text-sm text-foreground" dir="ltr">
                          {parsed.source || copy.automaticStorage}
                        </dd>
                      </div>
                      <div className="min-w-0">
                        <dt className="mb-1 text-xs text-muted-foreground">{copy.serviceLabel}</dt>
                        <dd className="break-all font-mono text-sm text-foreground" dir="ltr">
                          {parsed.target || "—"}
                        </dd>
                      </div>
                    </dl>
                    <p className="mt-2 text-xs text-muted-foreground">
                      {copy.kinds[parsed.kind]}
                      {parsed.readOnly ? ` · ${copy.readOnly}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                    {loading ? (
                      <UiIcon name="spinner" className="size-4 animate-spin" aria-label={copy.measuring} />
                    ) : measured?.bytes != null ? (
                      formatBytes(measured.bytes)
                    ) : (
                      "—"
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : (
        <div className="border-t border-border/40 px-5 py-10 text-center">
          <UiIcon name="hard-drive" className="mx-auto mb-3 size-6 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground">{copy.emptyTitle}</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{copy.emptyDescription}</p>
        </div>
      )}
      {backupFeedback && (
        <div className="space-y-3 border-t border-border/40 p-5">{backupFeedback}</div>
      )}
    </section>
  );
}
