import React, { useEffect, useState } from "react";
import { AlertTriangle, Database, HardDrive, Loader2 } from "lucide-react";
import { projectsApi } from "@/lib/api";
import { Checkbox } from "@/components/ui/Checkbox";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: (deleteApp: boolean, wipeVolumes: boolean, recordOnly: boolean) => void;
  projectName: string;
  projectId?: string | number;
  /** Static self-hosted signal from the caller (not cloud-managed). Gates the
   *  record-only option WITHOUT waiting on / trusting the live deletion preview,
   *  which can't resolve an unreachable or freshly-imported server. */
  selfHosted?: boolean;
}

interface ServicePreview {
  id: string;
  name: string;
  image: string | null;
  volumes: string[];
  hasContainer: boolean;
}

interface Preview {
  selfHosted: boolean;
  services: ServicePreview[];
  deploymentVolumes: string[];
  networks: string[];
  totalVolumes: number;
}

export const DeletionModal = ({
  isOpen,
  onClose,
  onConfirm,
  projectName,
  projectId,
  selfHosted,
}: Props) => {
  const { t } = useI18n();
  const [inputValue, setInputValue] = useState("");
  const [deleteApp, setDeleteApp] = useState(true);
  const [wipeVolumes, setWipeVolumes] = useState(false);
  // Record-only ("soft") delete: keep the workload + data on the server, drop
  // only the Openship record. Self-hosted only (hidden for cloud below).
  const [recordOnly, setRecordOnly] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const isConfirmDisabled = inputValue !== projectName;

  // Reset state + fetch the deletion preview each time the modal opens.
  // Preview is a read-only snapshot of what teardown will touch - services
  // with their named volumes, networks. Used to render the wipe-data toggle
  // intelligently (no toggle when there's nothing to wipe).
  useEffect(() => {
    if (!isOpen) return;
    setInputValue("");
    setDeleteApp(true);
    setWipeVolumes(false);
    setRecordOnly(false);
    setPreview(null);

    if (!projectId) return;
    let cancelled = false;
    setPreviewLoading(true);
    projectsApi
      .deletionPreview(projectId)
      .then((res) => {
        if (cancelled) return;
        if (res?.success && res.preview) {
          setPreview({
            selfHosted: res.preview.selfHosted,
            services: res.preview.services,
            deploymentVolumes: res.preview.deploymentVolumes,
            networks: res.preview.networks,
            totalVolumes: res.preview.totalVolumes,
          });
        }
      })
      .catch(() => { /* preview is informational - silent on failure */ })
      .finally(() => { if (!cancelled) setPreviewLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, projectId]);

  if (!isOpen) return null;

  const hasVolumes = (preview?.totalVolumes ?? 0) > 0;
  const servicesWithVolumes = preview?.services.filter((s) => s.volumes.length > 0) ?? [];
  // Record-only is offered only for self-hosted projects (cloud must fully
  // delete — the backend enforces this regardless of the UI). Gate on the
  // caller's static signal when given (so an imported/unreachable-server project
  // still shows it), else fall back to the live preview.
  const canRecordOnly = selfHosted ?? (!previewLoading && !!preview?.selfHosted);
  const showWipeBlock = !previewLoading && preview?.selfHosted && hasVolumes && !recordOnly;

  const handleConfirm = () => {
    if (isConfirmDisabled) return;
    onConfirm(deleteApp, showWipeBlock ? wipeVolumes : false, recordOnly);
    onClose();
  };

  const handleClose = () => {
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4 z-50">
      <div
        className="border border-border/60 rounded-2xl max-w-lg w-full shadow-xl overflow-hidden"
        style={{ backgroundColor: "var(--th-card-bg-solid, var(--card))" }}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-border/40">
          <div className="size-9 rounded-xl bg-warning-bg border border-warning-border flex items-center justify-center shrink-0">
            <AlertTriangle className="size-[18px] text-warning" />
          </div>
          <div className="min-w-0">
            <h3 className="text-[15px] font-semibold text-foreground">{t.projectSettings.deletion.title}</h3>
            <p className="text-xs text-muted-foreground mt-0.5 truncate">
              {recordOnly
                ? t.projectSettings.deletion.recordOnlyReversible
                : t.projectSettings.deletion.cannotUndo}
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4 max-h-[70vh] overflow-y-auto">
          <p className="text-sm text-muted-foreground">
            {t.projectSettings.deletion.aboutToPrefix}<strong className="text-foreground">{projectName}</strong>{t.projectSettings.deletion.aboutToSuffix}
          </p>

          {/* App vs single environment */}
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/50 bg-muted/15 p-3">
            <Checkbox
              checked={deleteApp}
              onCheckedChange={setDeleteApp}
              tone="destructive"
              className="mt-0.5"
              aria-label={t.projectSettings.deletion.deleteAllAria}
            />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-foreground">{t.projectSettings.deletion.deleteAll}</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                {deleteApp
                  ? t.projectSettings.deletion.deleteAllOn
                  : t.projectSettings.deletion.deleteAllOff}
              </span>
            </span>
          </label>

          {/* Record-only (soft) delete — self-hosted only; keeps the workload on
              the server and drops just the Openship record. */}
          {canRecordOnly && (
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border/50 bg-muted/15 p-3">
              <Checkbox
                checked={recordOnly}
                onCheckedChange={setRecordOnly}
                className="mt-0.5"
                aria-label={t.projectSettings.deletion.recordOnlyLabel}
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-foreground">
                  {t.projectSettings.deletion.recordOnlyLabel}
                </span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {t.projectSettings.deletion.recordOnlyDesc}
                </span>
              </span>
            </label>
          )}

          {/* Wipe-volumes block - only shows when there's actual data on disk */}
          {previewLoading ? (
            <div className="flex items-center gap-2 rounded-xl border border-border/30 bg-muted/10 px-3 py-2.5 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t.projectSettings.deletion.scanning}
            </div>
          ) : showWipeBlock ? (
            <div className="rounded-xl border border-border/50 overflow-hidden">
              <label className="flex cursor-pointer items-start gap-3 bg-muted/15 px-3 py-3">
                <Checkbox
                  checked={wipeVolumes}
                  onCheckedChange={setWipeVolumes}
                  tone="destructive"
                  className="mt-0.5"
                  aria-label={t.projectSettings.deletion.wipeAria}
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <HardDrive className="size-3.5 text-muted-foreground" />
                    <span className="text-sm font-medium text-foreground">
                      {interpolate(preview!.totalVolumes === 1 ? t.projectSettings.deletion.wipeLabelOne : t.projectSettings.deletion.wipeLabelOther, { count: String(preview!.totalVolumes) })}
                    </span>
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                    {wipeVolumes
                      ? t.projectSettings.deletion.wipeOn
                      : t.projectSettings.deletion.wipeOff}
                  </span>
                </span>
              </label>

              {/* Service list - only services that actually have volumes */}
              {servicesWithVolumes.length > 0 && (
                <ul className="border-t border-border/40 divide-y divide-border/30">
                  {servicesWithVolumes.map((s) => (
                    <li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
                      <Database className="size-3.5 text-muted-foreground/70 shrink-0" />
                      <span className="text-[13px] font-medium text-foreground truncate flex-1">
                        {s.name}
                      </span>
                      <span className="text-[11px] tabular-nums text-muted-foreground/70 shrink-0">
                        {interpolate(s.volumes.length === 1 ? t.projectSettings.deletion.volOne : t.projectSettings.deletion.volOther, { count: String(s.volumes.length) })}
                      </span>
                    </li>
                  ))}
                  {preview!.deploymentVolumes.length > 0 && (
                    <li className="flex items-center gap-3 px-3 py-2.5">
                      <Database className="size-3.5 text-muted-foreground/70 shrink-0" />
                      <span className="text-[13px] font-medium text-foreground truncate flex-1">
                        {t.projectSettings.deletion.appData}
                      </span>
                      <span className="text-[11px] tabular-nums text-muted-foreground/70 shrink-0">
                        {interpolate(preview!.deploymentVolumes.length === 1 ? t.projectSettings.deletion.volOne : t.projectSettings.deletion.volOther, { count: String(preview!.deploymentVolumes.length) })}
                      </span>
                    </li>
                  )}
                </ul>
              )}
            </div>
          ) : null}

          {recordOnly ? (
            // Non-destructive: nothing on the server is touched.
            <div className="rounded-xl border border-border/50 bg-muted/20 px-3 py-2.5">
              <p className="text-xs leading-relaxed text-muted-foreground">
                {t.projectSettings.deletion.recordOnlyNote}
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-warning-border bg-warning-bg px-3 py-2.5">
              <p className="text-xs text-warning leading-relaxed">
                {wipeVolumes
                  ? t.projectSettings.deletion.amberWipe
                  : t.projectSettings.deletion.amberNoWipe}
              </p>
            </div>
          )}

          <div>
            <p className="text-xs text-muted-foreground mb-2">
              {t.projectSettings.deletion.typePrefix}<span className="font-mono text-foreground bg-muted/60 px-1 rounded">{projectName}</span>{t.projectSettings.deletion.typeSuffix}
            </p>
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder={projectName}
              spellCheck={false}
              autoComplete="off"
              className="w-full px-3 py-2 bg-muted/30 text-foreground border border-border/50 rounded-xl text-sm focus:border-primary/40 focus:ring-2 focus:ring-primary/15 outline-none transition-all"
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 border-t border-border/40 px-5 py-3 bg-muted/[0.04]">
          <button
            onClick={handleClose}
            className="px-4 py-2 rounded-xl bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.1] text-sm font-medium transition-colors"
          >
            {t.projectSettings.deletion.cancel}
          </button>
          <button
            onClick={handleConfirm}
            disabled={isConfirmDisabled}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
              isConfirmDisabled
                ? "bg-muted text-muted-foreground/70 cursor-not-allowed"
                : recordOnly
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-danger-solid text-white hover:bg-danger-solid/90"
            }`}
          >
            {recordOnly
              ? t.projectSettings.deletion.confirmRecordOnly
              : wipeVolumes
                ? deleteApp
                  ? t.projectSettings.deletion.confirmDeleteWipe
                  : t.projectSettings.deletion.confirmDeleteEnvWipe
                : deleteApp
                  ? t.projectSettings.deletion.confirmDelete
                  : t.projectSettings.deletion.confirmDeleteEnv}
          </button>
        </div>
      </div>
    </div>
  );
};
