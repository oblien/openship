"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

import React, { useEffect, useId, useRef, useState } from "react";
import {
  backupsApi,
  backupDestinationsApi,
  getApiBaseUrl,
  getApiErrorMessage,
  type BackupDestinationSummary,
  type BackupPolicy,
} from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { Input, inputVariants } from "@/components/ui/input";
import { Toggle } from "@/components/project-settings/ServerSideSwitch";
import { cn } from "@/lib/utils";
import { CreateDestinationModal } from "./CreateDestinationModal";
import { kindLabel } from "./destinationDisplay";
import { useI18n, interpolate } from "@/components/i18n-provider";
import {
  PAYLOAD_COMPRESSION_CODECS,
  PAYLOAD_KIND_AUTO,
  DEFAULT_RETAIN_COUNT,
  detectDbImage,
  isPolicyPayloadKind,
  operatorSelectableKinds,
  payloadSpec,
  validatePolicyPayload,
  type BackupPayloadSpec,
  type PayloadCompression,
  type PayloadConfigKey,
  type PayloadKind,
  type PolicyPayloadKind,
} from "@repo/core";

interface Props {
  projectId: string;
  serviceId?: string | null;
  serviceName?: string;
  /** The service's container image — powers the "Detected: Postgres" hint so
   *  the user sees what "Auto" will do. The backend stays the source of truth. */
  serviceImage?: string | null;
  existing?: BackupPolicy | null;
  /** Keep storage created from the project panel selected in a new policy. */
  initialDestination?: BackupDestinationSummary | null;
  onDestinationSaved?: (destination: BackupDestinationSummary) => void;
  submitLabel?: string;
  onClose: () => void;
  onSaved: (policy: BackupPolicy) => void | Promise<void>;
  /** Optional first-backup action. Ordinary saves never start a run. */
  onSavedAndRun?: (policy: BackupPolicy) => void | Promise<void>;
}

/**
 * The SAME image table the server's producers match on (`@repo/core`), not a copy.
 *
 * This used to be a hand-written mirror whose comment called drift "cosmetic". It
 * was not: #611 is an operator reading "Detected PostgreSQL — Auto backs it up with
 * pg_dump" here while the run silently used the volume fallback and captured
 * nothing. One table means the two cannot disagree about which database an image is.
 *
 * The server still knows more than this can — whether the service has a live
 * container, whether credentials are discoverable — so a match here is what Auto
 * will TRY, and the run record remains the authority on what it did.
 */
const detectDb = detectDbImage;

/**
 * One card per thing the operator picks between, derived from the catalog.
 *
 * `auto`, plus one card per operator-selectable kind — except that the four database
 * kinds collapse into a single `database` card holding an engine picker, because they
 * differ only in which tool runs and Auto already chooses that from the image.
 *
 * Derived rather than listed because the listed version was wrong. `type Method =
 * "auto" | "volume" | "custom"` predates the `path` kind, so files-and-folders backups
 * existed on the server, were accepted by the API, ran correctly — and were
 * unreachable from the only surface an operator uses. Worse, `methodFromKind` mapped
 * everything it did not recognise to `auto`, so opening a `path` policy in this dialog
 * and pressing Save silently rewrote it into a different kind of backup.
 */
type CardId = typeof PAYLOAD_KIND_AUTO | "database" | PayloadKind;

/**
 * Cards run database → filesystem → opaque.
 *
 * A `Record` over the shape union, so a new shape is a compile error here rather than
 * a card that silently sorts first. Within a shape, catalog order wins (`sort` is
 * stable), which is the same order that decides auto-detect priority on the server.
 * Opaque last on purpose: "write the command yourself" is the escape hatch, and an
 * escape hatch offered first reads as the recommended path.
 */
const SHAPE_ORDER: Record<BackupPayloadSpec["shape"], number> = {
  database: 0,
  filesystem: 1,
  opaque: 2,
};

const SHAPE_ICONS: Record<BackupPayloadSpec["shape"], IconName> = {
  database: "database",
  filesystem: "hard-drive",
  opaque: "terminal",
};

/** A nicer icon than the kind's shape implies. Opt-in; the shape default is fine. */
const KIND_ICONS: Partial<Record<PayloadKind, IconName>> = { path: "folder-tree" };

/**
 * Every `payloadConfig` option, and whether this dialog renders a control for it.
 *
 * A `Record` over the whole vocabulary, so adding a key to the catalog is a compile
 * error here until someone decides which of the two it is. That is the property the
 * dialog lacked: `quiesce`, `sourceIds`, `exclude` and `compression` had been readable
 * and writable through the API for as long as they had existed, and no surface offered
 * them, so the only way to reach them was to know they were there.
 *
 * The two `api-only` entries are deliberate, not deferred:
 *   `command`       the legacy spelling of `produceCommand`. One control writes the
 *                   canonical key and deletes this one; a second control would let an
 *                   operator save two divergent copies of one instruction.
 *   `artifactName`  names the object at the destination. No operational decision hangs
 *                   on it, and a wrong value is cosmetic rather than unrestorable.
 */
const CONTROL_COVERAGE: Record<PayloadConfigKey, "control" | "api-only"> = {
  paths: "control",
  exclude: "control",
  sourceIds: "control",
  quiesce: "control",
  compression: "control",
  clearPath: "control",
  produceCommand: "control",
  restoreCommand: "control",
  command: "api-only",
  artifactName: "api-only",
};

/** The compression choices, with `""` standing for "let the service decide". */
type CompressionChoice = "" | PayloadCompression;

/** `payloadConfig` as this form reads it. Every field is untrusted jsonb. */
interface StoredConfig {
  incremental?: unknown;
  produceCommand?: unknown;
  command?: unknown;
  restoreCommand?: unknown;
  paths?: unknown;
  exclude?: unknown;
  sourceIds?: unknown;
  quiesce?: unknown;
  compression?: unknown;
  clearPath?: unknown;
}

/** A textarea's lines as a list, trimmed, blanks dropped. */
const toList = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** A stored string list back into textarea text. Anything else reads as empty. */
const toText = (value: unknown): string =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === "string").join("\n") : "";

const toStr = (value: unknown): string => (typeof value === "string" ? value : "");

export function PolicyEditor({
  projectId,
  serviceId,
  serviceName,
  serviceImage,
  existing,
  initialDestination,
  onDestinationSaved,
  submitLabel,
  onClose,
  onSaved,
  onSavedAndRun,
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const w = t.widgets.backup.policyEditor;
  const q = w.quick;
  const titleId = useId();
  const advancedId = useId();
  const detected = detectDb(serviceImage);
  const CRON_PRESETS = [
    { label: w.presetHourly, value: "7 * * * *" },
    { label: w.presetDaily, value: "17 3 * * *" },
    { label: w.presetWeekly, value: "17 3 * * 0" },
    { label: w.presetMonthly, value: "17 3 1 * *" },
    { label: w.presetManual, value: "" },
  ];

  const selectable = operatorSelectableKinds();
  const dbSpecs = selectable.filter((spec) => spec.shape === "database");
  const cards: CardId[] = [
    PAYLOAD_KIND_AUTO,
    ...[...selectable]
      .sort((a, b) => SHAPE_ORDER[a.shape] - SHAPE_ORDER[b.shape])
      .map((spec): CardId => (spec.shape === "database" ? "database" : spec.kind))
      .filter((id, at, all) => all.indexOf(id) === at),
  ];

  const stored = (existing?.payloadConfig ?? {}) as StoredConfig;

  const [destinations, setDestinations] = useState<BackupDestinationSummary[]>(
    initialDestination ? [initialDestination] : [],
  );
  const [destinationId, setDestinationId] = useState(
    existing?.destinationId ?? initialDestination?.id ?? "",
  );
  const [showDestinationEditor, setShowDestinationEditor] = useState(false);
  const [destinationsLoading, setDestinationsLoading] = useState(true);
  const [destinationsError, setDestinationsError] = useState<string | null>(null);
  const [destinationRequest, setDestinationRequest] = useState(0);
  /**
   * The kind itself, not a three-way summary of it. An existing policy therefore opens
   * on what it actually is — including a `pg_dump` pinned by hand, which the old
   * three-way mapping showed as "Auto" and rewrote to `auto` on save.
   */
  const [kind, setKind] = useState<PolicyPayloadKind>(
    isPolicyPayloadKind(existing?.payloadKind)
      ? existing.payloadKind
      : serviceId
        ? (detected?.payloadKind ?? "volume")
        : PAYLOAD_KIND_AUTO,
  );
  /** Both key spellings: `command` is what this form used to write. */
  const [customCommand, setCustomCommand] = useState(
    toStr(stored.produceCommand) || toStr(stored.command),
  );
  const [restoreCommand, setRestoreCommand] = useState(toStr(stored.restoreCommand));
  const [pathsText, setPathsText] = useState(toText(stored.paths));
  const [excludeText, setExcludeText] = useState(toText(stored.exclude));
  const [sourceIdsText, setSourceIdsText] = useState(toText(stored.sourceIds));
  const [quiesce, setQuiesce] = useState(stored.quiesce === true);
  const [incremental, setIncremental] = useState(stored.incremental === true);
  const [clearPath, setClearPath] = useState(stored.clearPath === true);
  const [compression, setCompression] = useState<CompressionChoice>(
    PAYLOAD_COMPRESSION_CODECS.find((codec) => codec === stored.compression) ?? "",
  );
  const [cronExpression, setCronExpression] = useState(existing?.cronExpression ?? "");
  const [triggerOnPreDeploy, setTriggerOnPreDeploy] = useState(
    existing?.triggerOnPreDeploy ?? false,
  );
  const [enableWebhook, setEnableWebhook] = useState(!!existing?.webhookToken);
  const [retainCount, setRetainCount] = useState<number | "">(
    existing ? (existing.retainCount ?? "") : DEFAULT_RETAIN_COUNT,
  );
  const [retainDays, setRetainDays] = useState<number | "">(existing?.retainDays ?? "");
  const [preHook, setPreHook] = useState(existing?.preHook ?? "");
  const [postHook, setPostHook] = useState(existing?.postHook ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  // Collapsing the controls never resets a saved policy or an in-progress draft.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setDestinationsLoading(true);
    setDestinationsError(null);
    void backupDestinationsApi
      .list()
      .then((res) => {
        if (cancelled) return;
        // A destination can be created while this request is still in flight.
        setDestinations((current) => [
          ...res.data,
          ...current.filter((destination) => !res.data.some((item) => item.id === destination.id)),
        ]);
        if (!existing)
          setDestinationId(
            (current) =>
              current ||
              res.data.find((destination) => destination.isDefault)?.id ||
              res.data[0]?.id ||
              "",
          );
      })
      .catch((error) => {
        if (!cancelled) setDestinationsError(getApiErrorMessage(error, w.failedLoadDestinations));
      })
      .finally(() => {
        if (!cancelled) setDestinationsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [existing, destinationRequest, w.failedLoadDestinations]);

  const webhookUrl = existing?.webhookToken
    ? `${getApiBaseUrl()}webhooks/backup/${existing.webhookToken}`
    : null;

  const activeSpec: BackupPayloadSpec | null =
    kind === PAYLOAD_KIND_AUTO ? null : payloadSpec(kind);
  const activeCard: CardId =
    activeSpec === null
      ? PAYLOAD_KIND_AUTO
      : activeSpec.shape === "database"
        ? "database"
        : activeSpec.kind;

  /**
   * Which options this kind actually has — the catalog's answer, not a per-card list.
   *
   * So `volume` offers volume subsets and quiesce, `path` offers folders and the
   * replace-on-restore switch, and neither offers the other's. Before, the dialog
   * offered whatever its three cards happened to hardcode, which for two of the three
   * kinds was nothing at all.
   */
  const shows = (key: PayloadConfigKey): boolean =>
    CONTROL_COVERAGE[key] === "control" && (activeSpec?.configKeys.includes(key) ?? false);

  /** Which engine the database card lands on: what the image is, else the first. */
  const defaultDbKind = (): PayloadKind => {
    const match = detected?.payloadKind;
    if (match && dbSpecs.some((spec) => spec.kind === match)) return match;
    return dbSpecs[0]?.kind ?? "pg_dump";
  };

  const selectCard = (id: CardId) => {
    setKind(id === "database" ? defaultDbKind() : id);
  };

  const methodSummary =
    activeSpec === null
      ? detected
        ? interpolate(w.summaryLogical, { label: detected.label })
        : w.summaryVolume
      : activeSpec.shape === "database"
        ? interpolate(w.summaryLogical, { label: activeSpec.label })
        : activeSpec.kind === "path"
          ? w.summaryPath
          : activeSpec.kind === "volume"
            ? w.summaryVolume
            : activeSpec.kind === "custom_command"
              ? w.summaryCustom
              : activeSpec.label;
  const retentionSummary =
    [
      retainCount !== "" ? interpolate(w.keepN, { n: String(retainCount) }) : null,
      retainDays !== "" ? interpolate(w.olderThanN, { n: String(retainDays) }) : null,
    ]
      .filter(Boolean)
      .join(" · ") || w.retentionUnlimited;

  const cardCopy = (id: CardId): { label: string; desc: string; icon: IconName } => {
    switch (id) {
      case PAYLOAD_KIND_AUTO:
        return { label: w.methodAuto, desc: w.methodAutoDesc, icon: "sparkles" };
      case "database":
        return { label: w.methodDatabase, desc: w.methodDatabaseDesc, icon: "database" };
      case "path":
        return { label: w.methodPath, desc: w.methodPathDesc, icon: "folder-tree" };
      case "volume":
        return { label: w.methodVolume, desc: w.methodVolumeDesc, icon: "hard-drive" };
      case "custom_command":
        return { label: w.methodCustom, desc: w.methodCustomDesc, icon: "terminal" };
      default: {
        // A kind added to the catalog but not yet to this file's copy. It appears with
        // its catalog label — untranslated, and better than the alternative: the `path`
        // kind spent its whole existence absent from this dialog because the card list
        // was hand-written, so a kind the server supports must never be unreachable
        // merely for want of a locale key.
        const spec = payloadSpec(id);
        return {
          label: spec.label,
          desc: spec.method,
          icon: KIND_ICONS[spec.kind] ?? SHAPE_ICONS[spec.shape],
        };
      }
    }
  };

  /**
   * The `payloadConfig` to send, or `undefined` to leave the stored one alone.
   *
   * `undefined` for a kind with no options of its own (`auto`, the databases), which is
   * what keeps a value set through the API from being wiped by a dashboard save.
   *
   * Otherwise the stored object is the base and only THIS kind's declared keys are
   * written over it. Two consequences, both wanted: an option belonging to another kind
   * survives a switch and comes back if the operator switches back (the catalog's
   * validator deliberately permits cross-kind keys for exactly this), and a key the
   * operator emptied is DELETED rather than set to undefined — inside a replaced jsonb
   * object, absent is what "unset, use the default" means. Note that this is the
   * opposite of the top-level rule below, where a cleared field must be sent as null.
   */
  const buildPayloadConfig = (): Record<string, unknown> | undefined => {
    if ((!activeSpec || activeSpec.configKeys.length === 0) && incremental === (stored.incremental === true)) return undefined;
    const next: Record<string, unknown> = { ...(existing?.payloadConfig ?? {}) };
    if (incremental) next.incremental = true;
    else delete next.incremental;
    const set = (key: PayloadConfigKey, value: unknown) => {
      if (!shows(key)) return;
      if (value === undefined) delete next[key];
      else next[key] = value;
    };
    const list = (text: string): string[] | undefined => {
      const items = toList(text);
      return items.length > 0 ? items : undefined;
    };
    set("paths", list(pathsText));
    set("exclude", list(excludeText));
    set("sourceIds", list(sourceIdsText));
    set("quiesce", quiesce ? true : undefined);
    set("clearPath", clearPath ? true : undefined);
    set("compression", compression || undefined);
    set("produceCommand", customCommand.trim() || undefined);
    set("restoreCommand", restoreCommand.trim() || undefined);
    // The legacy spelling has to GO, not merely be shadowed: the producer prefers
    // `produceCommand`, so a stale `command` left on the row is a second copy of the
    // same instruction that nothing keeps in step with the one being edited here.
    if (shows("produceCommand")) delete next.command;
    return next;
  };

  const submit = async (runAfterSave = false) => {
    if (submitting.current) return;
    setFormError(null);
    if (!destinationId) {
      setFormError(w.selectDestinationAlert);
      return;
    }
    // Field-specific and translated for the three empty-field mistakes, which are the
    // ones an operator makes while filling this in.
    if (shows("produceCommand") && !customCommand.trim()) {
      setShowAdvanced(true);
      setFormError(w.customCommandRequired);
      return;
    }
    // A custom backup with no restore command captures artifacts nothing can put
    // back: the producer records `restoreCommand: null` and refuses forever, and the
    // run still reports success. Refusing the save is the only point at which that
    // is recoverable. Read off the catalog, so a future kind that also needs its
    // inverse recorded is covered without touching this line.
    if (activeSpec?.requiresRestoreCommand && !restoreCommand.trim()) {
      setShowAdvanced(true);
      setFormError(w.restoreCommandRequired);
      return;
    }
    if (shows("paths") && toList(pathsText).length === 0) {
      setShowAdvanced(true);
      setFormError(w.pathsRequired);
      return;
    }
    if (
      [retainCount, retainDays].some(
        (value) => value !== "" && (!Number.isInteger(value) || value < 1),
      )
    ) {
      setShowAdvanced(true);
      setFormError(q.invalidRetention);
      return;
    }
    const config = buildPayloadConfig();
    /**
     * The API's own validator, run here.
     *
     * Not a second implementation of it — the same function the policy service refuses
     * writes with, so this dialog cannot offer a save the server will reject, and the
     * semantic failures it catches (a relative path, one folder listed twice, a request
     * to clear `/etc`, a compression codec no pipeline can build) are stated once. Its
     * messages are English; the three above are the ones worth translating.
     */
    const invalid = validatePolicyPayload(kind, config ?? existing?.payloadConfig ?? null);
    if (invalid) {
      setShowAdvanced(true);
      setFormError(invalid);
      return;
    }
    submitting.current = true;
    setBusy(true);
    try {
      /**
       * What a CLEARED field has to send.
       *
       * `JSON.stringify` drops `undefined`, and the API reads an absent key as
       * "leave this alone" (the `!== undefined` guards in updatePolicy). So sending
       * `undefined` for a field the operator just emptied silently KEPT the old
       * value: picking the "Manual" schedule left the cron firing on the old
       * expression, and clearing the retention boxes left the stored count in place
       * while this dialog's own summary line said "Unlimited" — retention then
       * deleted backups the operator believed were retained.
       *
       * `null` on CREATE too, and deliberately: `retainCount: undefined` selects the
       * instance default (7) while explicit null means "keep every run", and this
       * form ships 7 as its default value — so an operator who empties the box has
       * chosen unlimited, which is exactly what the summary line above already tells
       * them they are getting.
       */
      const cleared = null;
      const payload = {
        serviceId: serviceId ?? null,
        destinationId,
        cronExpression: cronExpression || cleared,
        triggerOnPreDeploy,
        enableWebhook,
        retainCount: retainCount === "" ? cleared : Number(retainCount),
        retainDays: retainDays === "" ? cleared : Number(retainDays),
        payloadKind: kind,
        payloadConfig: config,
        // Same rule: an emptied hook has to be sent as null to actually be removed.
        preHook: preHook.trim() || cleared,
        postHook: postHook.trim() || cleared,
        enabled,
      };
      const saved = existing
        ? await backupsApi.updatePolicy(existing.id, payload)
        : await backupsApi.createPolicy(projectId, payload);
      await (runAfterSave && onSavedAndRun ? onSavedAndRun : onSaved)(saved.data);
    } catch (err) {
      setFormError(getApiErrorMessage(err, w.failedSave));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };

  const rotateToken = async () => {
    if (!existing || !window.confirm(w.rotateConfirm)) return;
    setBusy(true);
    try {
      const saved = await backupsApi.updatePolicy(existing.id, { rotateWebhookToken: true });
      await onSaved(saved.data);
    } catch (err) {
      setFormError(getApiErrorMessage(err, w.failedRotate));
    } finally {
      setBusy(false);
    }
  };

  const commandClass = cn(
    inputVariants({ variant: "filled" }),
    "h-auto min-h-20 resize-y font-mono",
  );

  const compressionOptions: Array<{ value: CompressionChoice; label: string }> = [
    { value: "", label: w.compressionAuto },
    { value: "zstd", label: w.compressionZstd },
    { value: "gzip", label: w.compressionGzip },
    { value: "none", label: w.compressionNone },
  ];

  if (showDestinationEditor) {
    return (
      <CreateDestinationModal
        isOpen
        onClose={() => setShowDestinationEditor(false)}
        onSaved={(destination) => {
          setDestinations((current) => [
            ...current.filter((item) => item.id !== destination.id),
            destination,
          ]);
          setDestinationId(destination.id);
          setShowDestinationEditor(false);
          onDestinationSaved?.(destination);
        }}
      />
    );
  }

  const quickScheduleOptions = [
    ...CRON_PRESETS.map((preset) => ({
      value: preset.value,
      label: preset.value ? preset.label : q.onDemand,
    })),
    ...(!CRON_PRESETS.some((preset) => preset.value === cronExpression)
      ? [{ value: cronExpression, label: q.customSchedule }]
      : []),
  ];
  const retentionPresets = [DEFAULT_RETAIN_COUNT, 14, 30];
  const retentionPreset =
    retainDays === "" && retainCount !== "" && retentionPresets.includes(retainCount)
      ? String(retainCount)
      : "custom";
  const isProjectAuto = !serviceId && kind === PAYLOAD_KIND_AUTO;
  const isDatabase = activeSpec?.shape === "database" || (kind === PAYLOAD_KIND_AUTO && !!detected);
  const isVolume = kind === "volume" || (kind === PAYLOAD_KIND_AUTO && !detected && !!serviceId);
  const presetTitle = isProjectAuto
    ? q.projectTitle
    : isDatabase
      ? interpolate(q.databaseTitle, { name: activeSpec?.label ?? detected!.label })
      : isVolume
        ? q.volumesTitle
        : methodSummary;
  const presetDescription = isProjectAuto
    ? q.projectDescription
    : isDatabase
      ? q.databaseDescription
      : isVolume
        ? toList(sourceIdsText).length
          ? q.selectedVolumesDescription
          : q.volumesDescription
        : kind === "path"
          ? q.filesDescription
          : q.customDescription;
  const canSaveAndRun = !existing && !!onSavedAndRun && !submitLabel;

  return (
    <Modal
      isOpen
      onClose={onClose}
      closable={!busy}
      showCloseButton={!busy}
      width={showAdvanced ? "1120px" : "600px"}
      height={showAdvanced ? "min(780px, calc(100dvh - 2rem))" : "auto"}
      maxWidth="100%"
      maxHeight="calc(100dvh - 2rem)"
      overflow="hidden"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        noValidate
        className="flex min-h-0 max-h-[calc(100dvh-2rem)] flex-1 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(canSaveAndRun);
        }}
      >
        <div className="flex shrink-0 items-center gap-3 px-5 py-5 pe-14 sm:px-6 sm:pe-14">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50 text-foreground">
            <UiIcon name="archive" className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold text-foreground">
              {existing ? w.editTitle : w.createTitle}
            </h2>
            <p className="mt-1 break-words text-sm text-muted-foreground">
              {serviceName
                ? interpolate(w.serviceLabel, { name: serviceName })
                : serviceId
                  ? t.projectSettings.backup.overview.serviceBackup
                  : q.projectTitle}
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 sm:px-6">
          <fieldset
            disabled={busy}
            className={cn(
              "min-w-0",
              showAdvanced &&
                "grid items-start gap-6 md:grid-cols-[16rem_minmax(0,1fr)] lg:grid-cols-[18rem_minmax(0,1fr)]",
            )}
          >
            <div className="min-w-0 space-y-5">
              <div className="flex items-start gap-3 rounded-2xl bg-muted/30 p-4">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-card text-muted-foreground">
                  <UiIcon
                    name={
                      isProjectAuto
                        ? "layers"
                        : isDatabase
                          ? "database"
                          : isVolume
                            ? "hard-drive"
                            : "folder-tree"
                    }
                    className="size-4"
                  />
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted-foreground">{q.contents}</p>
                  <p className="mt-0.5 text-sm font-medium text-foreground">{presetTitle}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {presetDescription}
                  </p>
                  {!enabled && (
                    <p className="mt-2 text-xs text-warning">
                      {t.projectSettings.backup.overview.paused}
                    </p>
                  )}
                </div>
              </div>

              <Field label={w.destination}>
                <CustomSelect<string>
                  aria-label={w.destination}
                  variant="filled"
                  disabled={busy}
                  value={destinationId}
                  onChange={setDestinationId}
                  placeholder={
                    destinationsLoading
                      ? t.projectSettings.backup.destinations.loading
                      : w.selectOption
                  }
                  options={destinations.map((d) => ({
                    value: d.id,
                    label: d.name,
                    description: kindLabel(d.kind, t.misc.backups),
                  }))}
                  emptyMessage={
                    destinationsLoading
                      ? t.projectSettings.backup.destinations.loading
                      : (destinationsError ?? t.misc.backups.emptyTitle)
                  }
                  footerAction={{
                    label: w.addDestination,
                    icon: <UiIcon name="plus" className="size-4" />,
                    onClick: () => setShowDestinationEditor(true),
                  }}
                />
                {destinationsError && (
                  <div role="alert" className="mt-2 flex items-center gap-2 text-xs text-danger">
                    <span className="flex-1">{destinationsError}</span>
                    <button
                      type="button"
                      onClick={() => setDestinationRequest((current) => current + 1)}
                      className="shrink-0 underline"
                    >
                      {w.retry}
                    </button>
                  </div>
                )}
              </Field>

              <div className={cn("grid gap-4 sm:grid-cols-2", showAdvanced && "md:grid-cols-1")}>
                <Field label={q.frequency}>
                  <CustomSelect<string>
                    aria-label={q.frequency}
                    variant="filled"
                    disabled={busy}
                    value={cronExpression}
                    onChange={setCronExpression}
                    options={quickScheduleOptions}
                  />
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {cronExpression ? t.projectSettings.backup.schedule.timezone : q.onDemandHint}
                  </p>
                </Field>
                <Field label={q.history}>
                  <CustomSelect<string>
                    aria-label={q.history}
                    variant="filled"
                    disabled={busy}
                    value={retentionPreset}
                    onChange={(value) => {
                      if (value === "custom") return;
                      setRetainCount(Number(value));
                      setRetainDays("");
                    }}
                    options={[
                      ...retentionPresets.map((count) => ({
                        value: String(count),
                        label: interpolate(q.keepBackups, { count: String(count) }),
                      })),
                      ...(retentionPreset === "custom"
                        ? [
                            {
                              value: "custom",
                              label: q.customRetention,
                              description: retentionSummary,
                            },
                          ]
                        : []),
                    ]}
                  />
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    {retentionPreset === "custom" ? retentionSummary : q.historyHint}
                  </p>
                </Field>
              </div>

              <div>
                <button
                  type="button"
                  aria-label={w.advanced}
                  aria-expanded={showAdvanced}
                  aria-controls={advancedId}
                  onClick={() => setShowAdvanced((value) => !value)}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl p-3 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                    showAdvanced ? "bg-muted/50" : "bg-muted/20 hover:bg-muted/40",
                  )}
                >
                  <UiIcon name="settings" className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">{w.advanced}</span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {q.advancedHint}
                    </span>
                  </span>
                  <UiIcon
                    name="chevron-down"
                    className={`size-4 shrink-0 text-muted-foreground transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                  />
                </button>
              </div>
            </div>
            {showAdvanced && (
              <div id={advancedId} className="@container min-w-0 space-y-5">
                <section className="rounded-2xl bg-muted/20 p-4 sm:p-5">
                  <ToggleField
                    label={w.incrementalLabel}
                    hint={w.incrementalHint}
                    checked={incremental}
                    onChange={setIncremental}
                    disabled={busy}
                  />
                </section>
                <section className="rounded-2xl bg-muted/20 p-4 sm:p-5">
                  <h3 className="mb-3 text-sm font-medium text-foreground">{w.methodLabel}</h3>
                  <div className="grid grid-cols-2 gap-2 @xl:grid-cols-3">
                    {cards.map((id) => {
                      const active = activeCard === id;
                      const { label, desc, icon: Icon } = cardCopy(id);
                      return (
                        <button
                          key={id}
                          type="button"
                          aria-pressed={active}
                          onClick={() => selectCard(id)}
                          className={`flex min-w-0 flex-col items-start gap-1.5 rounded-xl p-3 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                            active ? "bg-primary/10" : "bg-background hover:bg-background/70"
                          }`}
                        >
                          <span className="mb-1 flex w-full items-center justify-between gap-2">
                            <UiIcon
                              name={Icon}
                              className={`size-4 ${active ? "text-primary" : "text-muted-foreground"}`}
                            />
                            {active && <UiIcon name="check" className="size-3.5 text-primary" />}
                          </span>
                          <span className="text-sm font-medium text-foreground">{label}</span>
                          <span className="text-xs leading-relaxed text-muted-foreground">
                            {desc}
                          </span>
                        </button>
                      );
                    })}
                  </div>

                  {/* The chosen kind's own hint, then its own options. */}
                  {activeCard === PAYLOAD_KIND_AUTO && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {detected
                        ? interpolate(w.detected, {
                            label: detected.label,
                            method: detected.method,
                          })
                        : w.autoNoDb}
                    </p>
                  )}
                  {activeCard === "database" && activeSpec && (
                    <div className="mt-3 space-y-3">
                      <Field label={w.engineLabel} hint={w.engineHint}>
                        <CustomSelect<PayloadKind>
                          aria-label={w.engineLabel}
                          variant="filled"
                          value={activeSpec.kind}
                          onChange={setKind}
                          options={dbSpecs.map((spec) => ({
                            value: spec.kind,
                            label: spec.label,
                            description: spec.method,
                          }))}
                        />
                      </Field>
                      <p className="text-xs text-muted-foreground">
                        {interpolate(w.databaseHint, { method: activeSpec.method })}
                      </p>
                    </div>
                  )}
                  {activeCard === "path" && (
                    <p className="mt-2 text-xs text-muted-foreground">{w.pathHint}</p>
                  )}
                  {activeCard === "volume" && (
                    <p className="mt-2 text-xs text-muted-foreground">{w.volumeHint}</p>
                  )}

                  <div className="mt-3 space-y-3">
                    {shows("paths") && (
                      <Field label={w.pathsLabel} hint={w.pathsHint}>
                        <textarea
                          aria-label={w.pathsLabel}
                          value={pathsText}
                          onChange={(e) => setPathsText(e.target.value)}
                          rows={3}
                          placeholder={"/var/www/html\n/data/uploads"}
                          className={commandClass}
                        />
                      </Field>
                    )}
                    {shows("sourceIds") && (
                      <Field label={w.sourceIdsLabel} hint={w.sourceIdsHint}>
                        <textarea
                          aria-label={w.sourceIdsLabel}
                          value={sourceIdsText}
                          onChange={(e) => setSourceIdsText(e.target.value)}
                          rows={2}
                          className={commandClass}
                        />
                      </Field>
                    )}
                    {shows("produceCommand") && (
                      <Field label={w.customCommandLabel} hint={w.customCommandHint}>
                        <textarea
                          aria-label={w.customCommandLabel}
                          value={customCommand}
                          onChange={(e) => setCustomCommand(e.target.value)}
                          rows={2}
                          placeholder="pg_dump -Fc -U $POSTGRES_USER $POSTGRES_DB"
                          className={commandClass}
                        />
                      </Field>
                    )}
                    {shows("restoreCommand") && (
                      <Field label={w.restoreCommandLabel} hint={w.restoreCommandHint}>
                        <textarea
                          aria-label={w.restoreCommandLabel}
                          value={restoreCommand}
                          onChange={(e) => setRestoreCommand(e.target.value)}
                          rows={2}
                          placeholder="pg_restore -c -U $POSTGRES_USER -d $POSTGRES_DB"
                          className={commandClass}
                        />
                      </Field>
                    )}
                    {shows("exclude") && (
                      <Field label={w.excludeLabel} hint={w.excludeHint}>
                        <textarea
                          aria-label={w.excludeLabel}
                          value={excludeText}
                          onChange={(e) => setExcludeText(e.target.value)}
                          rows={2}
                          className={commandClass}
                        />
                      </Field>
                    )}
                    {shows("compression") && (
                      <Field label={w.compressionLabel} hint={w.compressionHint}>
                        <CustomSelect<CompressionChoice>
                          aria-label={w.compressionLabel}
                          variant="filled"
                          value={compression}
                          disabled={incremental}
                          onChange={setCompression}
                          options={compressionOptions}
                        />
                      </Field>
                    )}
                    {shows("quiesce") && (
                      <ToggleField
                        label={w.quiesceLabel}
                        hint={w.quiesceHint}
                        checked={quiesce}
                        onChange={setQuiesce}
                        disabled={busy}
                      />
                    )}
                    {shows("clearPath") && (
                      <ToggleField
                        label={w.clearPathLabel}
                        hint={w.clearPathHint}
                        checked={clearPath}
                        onChange={setClearPath}
                        disabled={busy}
                      />
                    )}
                  </div>
                </section>

                <section className="space-y-5 rounded-2xl bg-muted/20 p-4 sm:p-5">
                  <Field label={q.customSchedule} hint={t.projectSettings.backup.schedule.timezone}>
                    <div className="space-y-2">
                      <div className="flex flex-wrap gap-2">
                        {CRON_PRESETS.map((p) => (
                          <button
                            key={p.label}
                            type="button"
                            aria-pressed={cronExpression === p.value}
                            onClick={() => setCronExpression(p.value)}
                            className={`rounded-lg px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 ${
                              cronExpression === p.value
                                ? "bg-primary/10 text-foreground"
                                : "bg-background text-muted-foreground hover:bg-background/70"
                            }`}
                          >
                            {p.label}
                          </button>
                        ))}
                      </div>
                      <Input
                        aria-label={q.customSchedule}
                        variant="filled"
                        value={cronExpression}
                        onChange={(e) => setCronExpression(e.target.value)}
                        placeholder={w.cronPlaceholder}
                        className="font-mono"
                      />
                    </div>
                  </Field>

                  <div className="grid gap-4 @sm:grid-cols-2">
                    <Field label={w.retainCount} hint={w.retainCountHint}>
                      <Input
                        aria-label={w.retainCount}
                        variant="filled"
                        type="number"
                        value={retainCount}
                        onChange={(e) =>
                          setRetainCount(e.target.value === "" ? "" : Number(e.target.value))
                        }
                        min={1}
                      />
                    </Field>
                    <Field label={w.retainDays} hint={w.retainDaysHint}>
                      <Input
                        aria-label={w.retainDays}
                        variant="filled"
                        type="number"
                        value={retainDays}
                        onChange={(e) =>
                          setRetainDays(e.target.value === "" ? "" : Number(e.target.value))
                        }
                        min={1}
                      />
                    </Field>
                  </div>
                </section>

                <section className="space-y-5 rounded-2xl bg-muted/20 p-4 sm:p-5">
                  <ToggleField
                    label={w.preDeployTrigger}
                    hint={w.preDeployHint}
                    icon="calendar"
                    checked={triggerOnPreDeploy}
                    onChange={setTriggerOnPreDeploy}
                    disabled={busy}
                  />

                  <div>
                    <ToggleField
                      label={w.webhookTrigger}
                      hint={w.webhookHint}
                      icon="globe"
                      checked={enableWebhook}
                      onChange={setEnableWebhook}
                      disabled={busy}
                    />
                    {webhookUrl && (
                      <div className="mt-3 flex min-w-0 items-center gap-2 rounded-xl bg-background px-3 py-2 font-mono text-xs">
                        <code className="min-w-0 flex-1 truncate" title={webhookUrl}>
                          {webhookUrl}
                        </code>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={() => navigator.clipboard.writeText(webhookUrl)}
                          className="size-8 shrink-0"
                          title={w.copyUrl}
                          aria-label={w.copyUrl}
                        >
                          <UiIcon name="copy" className="size-3" />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          onClick={rotateToken}
                          className="size-8 shrink-0"
                          title={w.rotateToken}
                          aria-label={w.rotateToken}
                        >
                          <UiIcon name="refresh" className="size-3" />
                        </Button>
                      </div>
                    )}
                  </div>

                  <Field
                    label={
                      <span className="flex items-center gap-1.5">
                        <UiIcon name="clock" className="size-3.5" />
                        {w.preHook}
                      </span>
                    }
                    hint={w.preHookHint}
                  >
                    <textarea
                      aria-label={w.preHook}
                      value={preHook}
                      onChange={(e) => setPreHook(e.target.value)}
                      rows={2}
                      className={commandClass}
                    />
                  </Field>

                  <Field label={w.postHook} hint={w.postHookHint}>
                    <textarea
                      aria-label={w.postHook}
                      value={postHook}
                      onChange={(e) => setPostHook(e.target.value)}
                      rows={2}
                      className={commandClass}
                    />
                  </Field>
                  <ToggleField
                    label={w.policyEnabled}
                    checked={enabled}
                    onChange={setEnabled}
                    disabled={busy}
                  />
                </section>
              </div>
            )}
          </fieldset>
        </div>

        <div className="shrink-0 space-y-3 border-t border-border/50 px-5 py-4 sm:px-6">
          {formError && (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              disabled={busy}
              className="px-3 text-xs sm:px-4 sm:text-sm"
            >
              {w.cancel}
            </Button>
            <div className="flex flex-1 flex-wrap justify-end gap-2">
              {canSaveAndRun && (
                <Button
                  type="button"
                  variant="secondary"
                  className="px-3 text-xs sm:px-4 sm:text-sm"
                  disabled={busy || !destinationId}
                  onClick={() => void submit()}
                >
                  {w.createPolicy}
                </Button>
              )}
              <Button
                type="submit"
                className="px-3 text-xs sm:px-4 sm:text-sm"
                disabled={busy || !destinationId}
              >
                {busy ? <UiIcon name="spinner" className="size-4 animate-spin" /> : null}
                {busy
                  ? w.saving
                  : canSaveAndRun
                    ? q.saveAndBackup
                    : (submitLabel ?? (existing ? w.saveChanges : w.createPolicy))}
              </Button>
            </div>
          </div>
        </div>
      </form>
    </Modal>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="min-w-0">
      <label className="block text-sm font-medium text-foreground">{label}</label>
      {hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      <div className="mt-2">{children}</div>
    </div>
  );
}

function ToggleField({
  label,
  hint,
  icon,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  icon?: IconName;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-medium text-foreground">
          {icon && <UiIcon name={icon} className="size-4 shrink-0 text-muted-foreground" />}
          {label}
        </p>
        {hint && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      <div className="mt-0.5">
        <Toggle checked={checked} onChange={onChange} disabled={disabled} aria-label={label} />
      </div>
    </div>
  );
}
