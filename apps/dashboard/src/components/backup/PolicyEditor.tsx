"use client";

import React, { useEffect, useState } from "react";
import {
  Copy,
  RefreshCw,
  Globe,
  Clock,
  Calendar,
  Sparkles,
  HardDrive,
  Terminal,
  ChevronDown,
  Database,
  FolderTree,
} from "lucide-react";
import {
  backupsApi,
  backupDestinationsApi,
  getApiBaseUrl,
  getApiErrorMessage,
  type BackupDestinationSummary,
  type BackupPolicy,
} from "@/lib/api";
import { Modal } from "@/components/ui/Modal";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { useI18n, interpolate } from "@/components/i18n-provider";
import {
  PAYLOAD_COMPRESSION_CODECS,
  PAYLOAD_KIND_AUTO,
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
  onClose: () => void;
  onSaved: () => void;
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

const SHAPE_ICONS: Record<BackupPayloadSpec["shape"], typeof Sparkles> = {
  database: Database,
  filesystem: HardDrive,
  opaque: Terminal,
};

/** A nicer icon than the kind's shape implies. Opt-in; the shape default is fine. */
const KIND_ICONS: Partial<Record<PayloadKind, typeof Sparkles>> = { path: FolderTree };

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
  onClose,
  onSaved,
}: Props): React.JSX.Element {
  const { t } = useI18n();
  const w = t.widgets.backup.policyEditor;
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

  const [destinations, setDestinations] = useState<BackupDestinationSummary[]>([]);
  const [destinationId, setDestinationId] = useState(existing?.destinationId ?? "");
  /**
   * The kind itself, not a three-way summary of it. An existing policy therefore opens
   * on what it actually is — including a `pg_dump` pinned by hand, which the old
   * three-way mapping showed as "Auto" and rewrote to `auto` on save.
   */
  const [kind, setKind] = useState<PolicyPayloadKind>(
    isPolicyPayloadKind(existing?.payloadKind) ? existing.payloadKind : PAYLOAD_KIND_AUTO,
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
  const [clearPath, setClearPath] = useState(stored.clearPath === true);
  const [compression, setCompression] = useState<CompressionChoice>(
    PAYLOAD_COMPRESSION_CODECS.find((codec) => codec === stored.compression) ?? "",
  );
  const [cronExpression, setCronExpression] = useState(existing?.cronExpression ?? "");
  const [triggerOnPreDeploy, setTriggerOnPreDeploy] = useState(existing?.triggerOnPreDeploy ?? false);
  const [enableWebhook, setEnableWebhook] = useState(!!existing?.webhookToken);
  const [retainCount, setRetainCount] = useState<number | "">(existing?.retainCount ?? 7);
  const [retainDays, setRetainDays] = useState<number | "">(existing?.retainDays ?? "");
  const [preHook, setPreHook] = useState(existing?.preHook ?? "");
  const [postHook, setPostHook] = useState(existing?.postHook ?? "");
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  // Open Advanced by default when an existing policy already uses any of it.
  const [showAdvanced, setShowAdvanced] = useState(
    !!(existing?.triggerOnPreDeploy || existing?.webhookToken || existing?.preHook || existing?.postHook),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void backupDestinationsApi.list().then((res) => {
      setDestinations(res.data);
      if (!existing && res.data.length > 0 && !destinationId) setDestinationId(res.data[0].id);
    });
  }, [existing, destinationId]);

  const detected = detectDb(serviceImage);
  const webhookUrl = existing?.webhookToken
    ? `${getApiBaseUrl()}webhooks/backup/${existing.webhookToken}`
    : null;

  const activeSpec: BackupPayloadSpec | null = kind === PAYLOAD_KIND_AUTO ? null : payloadSpec(kind);
  const activeCard: CardId =
    activeSpec === null ? PAYLOAD_KIND_AUTO
    : activeSpec.shape === "database" ? "database"
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
        : activeSpec.kind === "path" ? w.summaryPath
        : activeSpec.kind === "volume" ? w.summaryVolume
        : activeSpec.kind === "custom_command" ? w.summaryCustom
        : activeSpec.label;
  const scheduleSummary =
    cronExpression === ""
      ? w.summaryScheduleManual
      : CRON_PRESETS.find((p) => p.value === cronExpression)?.label ?? cronExpression;
  const destName = destinations.find((d) => d.id === destinationId)?.name ?? "—";
  const retentionSummary =
    [
      retainCount !== "" ? interpolate(w.keepN, { n: String(retainCount) }) : null,
      retainDays !== "" ? interpolate(w.olderThanN, { n: String(retainDays) }) : null,
    ]
      .filter(Boolean)
      .join(" · ") || w.retentionUnlimited;

  const cardCopy = (id: CardId): { label: string; desc: string; icon: typeof Sparkles } => {
    switch (id) {
      case PAYLOAD_KIND_AUTO:
        return { label: w.methodAuto, desc: w.methodAutoDesc, icon: Sparkles };
      case "database":
        return { label: w.methodDatabase, desc: w.methodDatabaseDesc, icon: Database };
      case "path":
        return { label: w.methodPath, desc: w.methodPathDesc, icon: FolderTree };
      case "volume":
        return { label: w.methodVolume, desc: w.methodVolumeDesc, icon: HardDrive };
      case "custom_command":
        return { label: w.methodCustom, desc: w.methodCustomDesc, icon: Terminal };
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
    if (!activeSpec || activeSpec.configKeys.length === 0) return undefined;
    const next: Record<string, unknown> = { ...(existing?.payloadConfig ?? {}) };
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

  const submit = async () => {
    if (!destinationId) {
      window.alert(w.selectDestinationAlert);
      return;
    }
    // Field-specific and translated for the three empty-field mistakes, which are the
    // ones an operator makes while filling this in.
    if (shows("produceCommand") && !customCommand.trim()) {
      window.alert(w.customCommandRequired);
      return;
    }
    // A custom backup with no restore command captures artifacts nothing can put
    // back: the producer records `restoreCommand: null` and refuses forever, and the
    // run still reports success. Refusing the save is the only point at which that
    // is recoverable. Read off the catalog, so a future kind that also needs its
    // inverse recorded is covered without touching this line.
    if (activeSpec?.requiresRestoreCommand && !restoreCommand.trim()) {
      window.alert(w.restoreCommandRequired);
      return;
    }
    if (shows("paths") && toList(pathsText).length === 0) {
      window.alert(w.pathsRequired);
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
      window.alert(invalid);
      return;
    }
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
      if (existing) await backupsApi.updatePolicy(existing.id, payload);
      else await backupsApi.createPolicy(projectId, payload);
      onSaved();
    } catch (err) {
      window.alert(getApiErrorMessage(err, w.failedSave));
    } finally {
      setBusy(false);
    }
  };

  const rotateToken = async () => {
    if (!existing || !window.confirm(w.rotateConfirm)) return;
    setBusy(true);
    try {
      await backupsApi.updatePolicy(existing.id, { rotateWebhookToken: true });
      onSaved();
    } catch (err) {
      window.alert(getApiErrorMessage(err, w.failedRotate));
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    "w-full rounded-lg border border-border/50 bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20 transition-all";
  const commandClass =
    "w-full rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20";

  const compressionOptions: Array<{ value: CompressionChoice; label: string }> = [
    { value: "", label: w.compressionAuto },
    { value: "zstd", label: w.compressionZstd },
    { value: "gzip", label: w.compressionGzip },
    { value: "none", label: w.compressionNone },
  ];

  return (
    <Modal isOpen onClose={onClose} width="920px" maxWidth="95vw" maxHeight="88vh" overflow="hidden">
      {/* Header */}
      <div className="shrink-0 border-b border-border/50 px-6 pt-6 pb-4 pe-12">
        <h2 className="text-lg font-semibold text-foreground">{existing ? w.editTitle : w.createTitle}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {serviceName ? interpolate(w.serviceLabel, { name: serviceName }) : w.projectLevel}
        </p>
      </div>

      {/* Body — 2 columns */}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* Left: the essentials */}
        <div className="min-h-0 flex-[3] space-y-6 overflow-y-auto px-6 py-5">
          {/* Method — the hero */}
          <div>
            <label className="mb-2 block text-xs font-medium text-foreground/80">{w.methodLabel}</label>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
              {cards.map((id) => {
                const active = activeCard === id;
                const { label, desc, icon: Icon } = cardCopy(id);
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => selectCard(id)}
                    className={`flex flex-col items-start gap-1.5 rounded-xl border p-3 text-start transition-colors ${
                      active ? "border-primary/60 bg-primary/[0.08]" : "border-border/50 hover:bg-muted/40"
                    }`}
                  >
                    <Icon className={`size-4 ${active ? "text-primary" : "text-muted-foreground"}`} />
                    <span className="text-[13px] font-medium text-foreground">{label}</span>
                    <span className="text-[11px] leading-tight text-muted-foreground">{desc}</span>
                  </button>
                );
              })}
            </div>

            {/* The chosen kind's own hint, then its own options. */}
            {activeCard === PAYLOAD_KIND_AUTO && (
              <p className="mt-2 text-xs text-muted-foreground">
                {detected
                  ? interpolate(w.detected, { label: detected.label, method: detected.method })
                  : w.autoNoDb}
              </p>
            )}
            {activeCard === "database" && activeSpec && (
              <div className="mt-3 space-y-3">
                <Field label={w.engineLabel} hint={w.engineHint}>
                  <CustomSelect<PayloadKind>
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
            {activeCard === "path" && <p className="mt-2 text-xs text-muted-foreground">{w.pathHint}</p>}
            {activeCard === "volume" && <p className="mt-2 text-xs text-muted-foreground">{w.volumeHint}</p>}

            <div className="mt-3 space-y-3">
              {shows("paths") && (
                <Field label={w.pathsLabel} hint={w.pathsHint}>
                  <textarea
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
                    value={compression}
                    onChange={setCompression}
                    options={compressionOptions}
                  />
                </Field>
              )}
              {shows("quiesce") && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={quiesce}
                    onChange={(e) => setQuiesce(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-sm text-foreground/80">
                    <span className="font-medium">{w.quiesceLabel}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{w.quiesceHint}</span>
                  </span>
                </label>
              )}
              {shows("clearPath") && (
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={clearPath}
                    onChange={(e) => setClearPath(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-sm text-foreground/80">
                    <span className="font-medium">{w.clearPathLabel}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{w.clearPathHint}</span>
                  </span>
                </label>
              )}
            </div>
          </div>

          <Field label={w.destination}>
            <CustomSelect<string>
              value={destinationId}
              onChange={setDestinationId}
              placeholder={w.selectOption}
              options={destinations.map((d) => ({ value: d.id, label: d.name, description: d.kind }))}
            />
          </Field>

          <Field label={w.schedule}>
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                {CRON_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    onClick={() => setCronExpression(p.value)}
                    className={`rounded-lg border px-2.5 py-1 text-xs transition-colors ${
                      cronExpression === p.value
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border/50 text-muted-foreground hover:bg-muted/50"
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                value={cronExpression}
                onChange={(e) => setCronExpression(e.target.value)}
                placeholder={w.cronPlaceholder}
                className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20"
              />
            </div>
          </Field>
        </div>

        {/* Right: live summary + retention + advanced */}
        <div className="min-h-0 flex-[2] space-y-5 overflow-y-auto border-t border-border/50 bg-muted/[0.15] px-6 py-5 lg:border-s lg:border-t-0">
          <div className="rounded-xl border border-border/50 bg-card p-4">
            <p className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/70">
              {w.summaryTitle}
            </p>
            <dl className="space-y-2.5 text-sm">
              <SummaryRow label={w.summaryMethod} value={methodSummary} />
              <SummaryRow label={w.schedule} value={scheduleSummary} />
              <SummaryRow label={w.destination} value={destName} />
              <SummaryRow label={w.retainCount} value={retentionSummary} />
            </dl>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label={w.retainCount} hint={w.retainCountHint}>
              <input
                type="number"
                value={retainCount}
                onChange={(e) => setRetainCount(e.target.value === "" ? "" : Number(e.target.value))}
                min={1}
                className={inputClass}
              />
            </Field>
            <Field label={w.retainDays} hint={w.retainDaysHint}>
              <input
                type="number"
                value={retainDays}
                onChange={(e) => setRetainDays(e.target.value === "" ? "" : Number(e.target.value))}
                min={1}
                className={inputClass}
              />
            </Field>
          </div>

          <div>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="flex items-center gap-1.5 text-sm font-medium text-foreground/80 transition-colors hover:text-foreground"
            >
              <ChevronDown className={`size-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
              {w.advanced}
            </button>

            {showAdvanced && (
              <div className="mt-4 space-y-5">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    checked={triggerOnPreDeploy}
                    onChange={(e) => setTriggerOnPreDeploy(e.target.checked)}
                    className="mt-0.5"
                  />
                  <span className="text-sm text-foreground/80">
                    <span className="flex items-center gap-1.5 font-medium">
                      <Calendar className="size-3.5" />
                      {w.preDeployTrigger}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{w.preDeployHint}</span>
                  </span>
                </label>

                <div>
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      checked={enableWebhook}
                      onChange={(e) => setEnableWebhook(e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="text-sm text-foreground/80">
                      <span className="flex items-center gap-1.5 font-medium">
                        <Globe className="size-3.5" />
                        {w.webhookTrigger}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">{w.webhookHint}</span>
                    </span>
                  </label>
                  {webhookUrl && (
                    <div className="mt-2 flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 font-mono text-[11px]">
                      <code className="flex-1 truncate">{webhookUrl}</code>
                      <button onClick={() => navigator.clipboard.writeText(webhookUrl)} className="rounded p-1 hover:bg-background" title={w.copyUrl}>
                        <Copy className="size-3" />
                      </button>
                      <button onClick={rotateToken} className="rounded p-1 hover:bg-background" title={w.rotateToken}>
                        <RefreshCw className="size-3" />
                      </button>
                    </div>
                  )}
                </div>

                <Field
                  label={
                    <span className="flex items-center gap-1.5">
                      <Clock className="size-3.5" />
                      {w.preHook}
                    </span>
                  }
                  hint={w.preHookHint}
                >
                  <textarea
                    value={preHook}
                    onChange={(e) => setPreHook(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20"
                  />
                </Field>

                <Field label={w.postHook} hint={w.postHookHint}>
                  <textarea
                    value={postHook}
                    onChange={(e) => setPostHook(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/20"
                  />
                </Field>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="shrink-0 flex items-center justify-between gap-3 border-t border-border/50 px-6 py-4">
        <label className="flex items-center gap-2 text-sm text-foreground/80">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {w.policyEnabled}
        </label>
        <div className="flex items-center gap-2">
          <button onClick={onClose} disabled={busy} className="rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted">
            {w.cancel}
          </button>
          <button
            onClick={submit}
            disabled={busy || !destinationId}
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {busy ? w.saving : existing ? w.saveChanges : w.createPolicy}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-end text-[13px] font-medium text-foreground">{value}</dd>
    </div>
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
    <div>
      <label className="block text-xs font-medium text-foreground/80">{label}</label>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
      <div className="mt-1.5">{children}</div>
    </div>
  );
}
