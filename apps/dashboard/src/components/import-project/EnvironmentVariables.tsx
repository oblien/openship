"use client";
import React, { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  FileText,
  Key,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { ENV_MASK, isMaskedValue } from "@repo/core";
import { useOptionalDeployment } from "@/context/DeploymentContext";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";

// #336: env values arrive masked as ENV_MASK (shared with the API via @repo/core
// so the exact sentinel can't drift). A masked row keeps the sentinel in state —
// a save round-trips it and the backend restores the stored secret; "show
// values" reveals real values into a display-only overlay; editing a revealed
// row replaces the sentinel with the typed value.
type EnvironmentVariableRow = { key: string; value: string; visible: boolean };

type EnvironmentVariableMeta = {
  source: "env-file" | "default" | "missing" | "interpolated";
  variable?: string;
  defaultValue?: string;
  resolvedValue: string;
  expression?: string;
};

interface EnvironmentVariablesPropsOptional {
  mode?: "deploy" | "settings";
  showEditControls?: boolean;
  isEditingMode?: boolean;
  setIsEditingMode?: (editing: boolean) => void;
  onSave?: () => void;
  onCancel?: () => void;
  hasChanges?: boolean;
  isSaving?: boolean;
  showSettingsActions?: boolean;
  /** When true, removes the outer card border and inner divider - for embedding inside another card. */
  borderless?: boolean;
  /** When true, the body (paste zone + variable list) starts hidden and a
   *  chevron toggle is added to the header. Paste / upload actions
   *  auto-expand so the operator sees the parsed result land. The header
   *  itself - including Paste .env and Upload .env - stays visible at all
   *  times so the primary affordances aren't hidden behind the chevron. */
  collapsible?: boolean;
  // For settings mode - external env vars
  envVars?: EnvironmentVariableRow[];
  envMeta?: Record<string, EnvironmentVariableMeta>;
  onEnvVarsChange?: (envVars: EnvironmentVariableRow[]) => void;
  /**
   * #336: fetch the REAL (unmasked) env values, keyed by env key. When provided
   * and any row is masked (`••••••••`), a "Show values" toggle appears that
   * reveals them in a display-only overlay. Omit when there's no reveal source
   * (a new, unsaved service) — the toggle simply won't show.
   */
  onRevealAll?: () => Promise<Record<string, string>>;
}

const EnvironmentVariables: React.FC<EnvironmentVariablesPropsOptional> = ({
  mode = "deploy",
  showEditControls = true,
  isEditingMode: externalIsEditingMode,
  setIsEditingMode: externalSetIsEditingMode,
  onSave,
  onCancel,
  hasChanges,
  isSaving = false,
  showSettingsActions = true,
  borderless = false,
  collapsible = false,
  envVars: externalEnvVars,
  envMeta,
  onEnvVarsChange,
  onRevealAll,
}) => {
  const deployment = useOptionalDeployment();
  const { showToast } = useToast();
  const { t } = useI18n();
  const ev = t.importProject.environmentVariables;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteZoneRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [internalIsEditingMode, setInternalIsEditingMode] = useState(mode === "deploy");
  // Body starts hidden when `collapsible` is set. Auto-expanded by the
  // paste / upload handlers below so the user sees parsed rows land
  // without an extra click.
  const [expanded, setExpanded] = useState(!collapsible);
  
  // Use external state if provided, otherwise use internal state
  const isEditingMode = externalIsEditingMode !== undefined ? externalIsEditingMode : internalIsEditingMode;
  const setIsEditingMode = externalSetIsEditingMode || setInternalIsEditingMode;

  // Use external env vars in settings mode, deployment context in deploy mode
  if (mode === "deploy" && !deployment) {
    throw new Error("EnvironmentVariables in deploy mode must be used within DeploymentProvider");
  }

  const currentEnvVars = mode === "settings"
    ? (externalEnvVars ?? [])
    : (deployment?.config.envVars ?? []);

  const updateEnvVars = mode === "settings" && onEnvVarsChange
    ? onEnvVarsChange
    : (newVars: EnvironmentVariableRow[]) => deployment?.updateConfig({ envVars: newVars });

  const addEnvVar = useCallback(() => {
    // Default visible so you can see what you type; the eye toggles to hide.
    const newEnvVars = [...currentEnvVars, { key: "", value: "", visible: true }];
    updateEnvVars(newEnvVars);
    // Auto-enable editing mode when adding in settings mode
    if (mode === "settings") {
      setIsEditingMode(true);
    }
  }, [currentEnvVars, updateEnvVars, mode, setIsEditingMode]);

  const removeEnvVar = useCallback(
    (index: number) => {
      const newEnvVars = currentEnvVars.filter((_, i) => i !== index);
      updateEnvVars(newEnvVars);
    },
    [currentEnvVars, updateEnvVars]
  );

  const updateEnvVar = useCallback(
    (
      index: number,
      field: keyof (typeof currentEnvVars)[0],
      value: string | boolean
    ) => {
      const newEnvVars = currentEnvVars.map((env, i) => (i === index ? { ...env, [field]: value } : env));
      updateEnvVars(newEnvVars);
    },
    [currentEnvVars, updateEnvVars]
  );

  // #336: display-only overlay of revealed real values (keyed by env key). Kept
  // out of `currentEnvVars` on purpose: the row value stays the mask sentinel
  // until the user actually edits it, so revealing never marks the form dirty
  // and a save still round-trips the sentinel (backend keeps the stored secret).
  const [revealedValues, setRevealedValues] = useState<Record<string, string> | null>(null);
  // Which masked rows are currently SHOWN as text, keyed by env key — a local
  // overlay, NOT the row's `visible` field. A masked row's value is a sentinel, so
  // its visibility is a pure display concern; routing it through `updateEnvVars`
  // would (a) mark the form dirty and (b) silently drop in the migration editor,
  // whose Record<string,string> bridge (envToRows/rowsToEnv) can't carry `visible`.
  // Keeping it here makes the eye work identically in every host.
  const [shownKeys, setShownKeys] = useState<Set<string>>(() => new Set());
  const [revealing, setRevealing] = useState(false);
  const hasMaskedRow = currentEnvVars.some((env) => isMaskedValue(env.value));

  // Fetch the real values from the server ONCE (via onRevealAll) into the overlay.
  // The ref dedupes concurrent callers — a rapid double-click, or the header toggle
  // racing a per-row eye — so onRevealAll fires a single time. Resolves to the map
  // (null when no reveal source is wired) and rejects — after toasting — so callers
  // bail without surfacing a second error.
  const revealPromiseRef = useRef<Promise<Record<string, string>> | null>(null);
  const ensureRevealed = useCallback(async (): Promise<Record<string, string> | null> => {
    if (revealedValues) return revealedValues;
    if (!onRevealAll) return null;
    if (!revealPromiseRef.current) {
      setRevealing(true);
      revealPromiseRef.current = onRevealAll()
        .then((vals) => {
          setRevealedValues(vals);
          return vals;
        })
        .catch((err) => {
          showToast(ev.reveal?.error ?? "Failed to reveal values", "error", ev.toast.title);
          throw err;
        })
        .finally(() => {
          setRevealing(false);
          revealPromiseRef.current = null;
        });
    }
    return revealPromiseRef.current;
  }, [revealedValues, onRevealAll, showToast, ev]);

  // The per-row eye. A masked row holds only the sentinel: the first reveal fetches
  // the real values from the server (once) and then this row is toggled shown/hidden
  // via the local `shownKeys` overlay. A plaintext row (new / already-typed) is the
  // plain local password/text flip on its own `visible` field.
  const toggleEnvVisibility = useCallback(
    async (index: number) => {
      const target = currentEnvVars[index];
      if (!target) return;
      if (isMaskedValue(target.value)) {
        if (onRevealAll && !(await ensureRevealed().catch(() => null))) return;
        setShownKeys((prev) => {
          const next = new Set(prev);
          if (next.has(target.key)) next.delete(target.key);
          else next.add(target.key);
          return next;
        });
        return;
      }
      updateEnvVars(
        currentEnvVars.map((env, i) => (i === index ? { ...env, visible: !env.visible } : env))
      );
    },
    [currentEnvVars, updateEnvVars, onRevealAll, ensureRevealed]
  );

  // Header "Show values" / "Hide values": reveal (fetch once) and show every masked
  // row via the overlay so the button is meaningful on its own; hide clears the
  // overlay and the shown set so nothing is left exposed.
  const toggleRevealAll = useCallback(async () => {
    if (revealedValues) {
      setRevealedValues(null);
      setShownKeys(new Set());
      return;
    }
    if (!(await ensureRevealed().catch(() => null))) return;
    setShownKeys(new Set(currentEnvVars.filter((e) => isMaskedValue(e.value)).map((e) => e.key)));
  }, [revealedValues, ensureRevealed, currentEnvVars]);

  const handleKeyChange = (index: number, value: string) => {
    updateEnvVar(index, "key", value);
  };

  const handleValueChange = (index: number, value: string) => {
    updateEnvVar(index, "value", value);
  };

  const mergeParsedEnvVars = useCallback(
    (parsed: EnvironmentVariableRow[], replaceEmptyRowIndex?: number) => {
      const existingMap = new Map(currentEnvVars.map((env, idx) => [env.key, idx]));
      const merged = [...currentEnvVars];
      const currentRow =
        typeof replaceEmptyRowIndex === "number" ? merged[replaceEmptyRowIndex] : undefined;
      const shouldRemoveEmptyRow =
        typeof replaceEmptyRowIndex === "number" &&
        currentRow !== undefined &&
        !currentRow.key &&
        !currentRow.value;

      let added = 0;
      let updated = 0;

      for (const nextVar of parsed) {
        const existingIdx = existingMap.get(nextVar.key);
        if (existingIdx !== undefined) {
          merged[existingIdx] = { ...merged[existingIdx], value: nextVar.value };
          updated++;
        } else {
          merged.push(nextVar);
          added++;
        }
      }

      if (shouldRemoveEmptyRow) {
        merged.splice(replaceEmptyRowIndex, 1);
      }

      updateEnvVars(merged);
      return { added, updated };
    },
    [currentEnvVars, updateEnvVars]
  );

  const showEnvPasteResult = useCallback(
    (parsedCount: number, added: number, updated: number) => {
      const parts: string[] = [];
      if (added > 0) parts.push(interpolate(ev.toast.added, { count: String(added) }));
      if (updated > 0) parts.push(interpolate(ev.toast.updated, { count: String(updated) }));
      const detail = parts.length ? ` (${parts.join(", ")})` : "";

      showToast(
        interpolate(parsedCount === 1 ? ev.toast.pastedOne : ev.toast.pastedOther, {
          count: String(parsedCount),
          detail,
        }),
        "success",
        ev.toast.title
      );
    },
    [showToast, ev]
  );

  const maybeAutoApplyDetectedPort = useCallback(
    (parsedVars: EnvironmentVariableRow[]) => {
      if (mode !== "deploy" || !deployment?.config.options.hasServer) {
        return;
      }

      const detectedPort = detectContainerPort(parsedVars);
      if (!detectedPort) {
        return;
      }

      const currentPort = deployment.config.options.productionPort.trim();
      const lastAutoDetectedPort = deployment.config.lastAutoDetectedEnvPort?.trim() || "";
      const canAutoApply =
        !deployment.config.productionPortTouched &&
        (currentPort === "" || currentPort === lastAutoDetectedPort || lastAutoDetectedPort === "");

      if (!canAutoApply || currentPort === detectedPort) {
        return;
      }

      deployment.updateConfig({
        lastAutoDetectedEnvPort: detectedPort,
        options: {
          ...deployment.config.options,
          productionPort: detectedPort,
        },
      });
      showToast(interpolate(ev.toast.portSet, { port: detectedPort }), "success", ev.toast.title);
    },
    [deployment, mode, showToast, ev]
  );

  const applyEnvText = useCallback(
    (text: string, replaceEmptyRowIndex?: number) => {
      const parsed = parseEnvFile(text);
      if (parsed.length === 0) {
        return false;
      }

      const { added, updated } = mergeParsedEnvVars(parsed, replaceEmptyRowIndex);
      maybeAutoApplyDetectedPort(parsed);
      showEnvPasteResult(parsed.length, added, updated);
      return true;
    },
    [maybeAutoApplyDetectedPort, mergeParsedEnvVars, showEnvPasteResult]
  );

  const handleContainerPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (!isEditingMode) return;

      const text = e.clipboardData.getData("text");
      if (!text) return;

      const target = e.target instanceof HTMLElement ? e.target : null;
      const isTextInputPaste = Boolean(target?.closest("input, textarea, [contenteditable='true']"));

      if (!looksLikeEnvPaste(text, !isTextInputPaste)) {
        return;
      }

      e.preventDefault();

      const rowIndex = target ? getEnvRowIndexFromTarget(target) : undefined;
      const replaceEmptyRowIndex =
        typeof rowIndex === "number" &&
        currentEnvVars[rowIndex] &&
        !currentEnvVars[rowIndex].key &&
        !currentEnvVars[rowIndex].value
          ? rowIndex
          : undefined;

      applyEnvText(text, replaceEmptyRowIndex);
    },
    [applyEnvText, currentEnvVars, isEditingMode]
  );

  const handlePasteFromClipboard = useCallback(async () => {
    // No early-return on isEditingMode: settings-mode now also exposes
    // Paste .env in the header and enters edit mode on click. The
    // explicit button press IS the operator's intent — gating on
    // isEditingMode here would early-return because the setIsEditingMode
    // call happens in the same tick and the state hasn't propagated yet.
    if (
      typeof navigator === "undefined" ||
      typeof window === "undefined" ||
      !window.isSecureContext ||
      !navigator.clipboard?.readText
    ) {
      showToast(
        ev.toast.clipboardUnavailable,
        "error",
        ev.toast.title
      );
      return;
    }

    try {
      const text = await navigator.clipboard.readText();

      if (!text.trim()) {
        showToast(ev.toast.clipboardEmpty, "error", ev.toast.title);
        return;
      }

      if (!looksLikeEnvPaste(text, true) || !applyEnvText(text)) {
        showToast(
          ev.toast.clipboardInvalid,
          "error",
          ev.toast.title
        );
      } else {
        // Successful paste — reveal the body so the operator sees the
        // rows that just landed (no-op if not in collapsible mode).
        setExpanded(true);
      }
    } catch {
      showToast(
        ev.toast.clipboardBlocked,
        "error",
        ev.toast.title
      );
    }
  }, [applyEnvText, isEditingMode, showToast, ev]);

  const handlePasteZoneClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isEditingMode) return;

    const target = e.target as HTMLElement;
    if (target.closest("input, button, a, select, textarea, label")) {
      return;
    }

    pasteZoneRef.current?.focus();
  }, [isEditingMode]);

  const handleFileUpload = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      const parsedVars = parseEnvFile(content);

      if (parsedVars.length > 0) {
        // Merge with existing vars, avoiding duplicates
        const existingKeys = new Set(currentEnvVars.map(v => v.key));
        const newVars = parsedVars.filter(v => !existingKeys.has(v.key));
        updateEnvVars([...currentEnvVars, ...newVars]);
        maybeAutoApplyDetectedPort(parsedVars);
        setExpanded(true);
      }
    };
    reader.readAsText(file);
    
    // Reset input so same file can be uploaded again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [currentEnvVars, maybeAutoApplyDetectedPort, updateEnvVars]);

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  // Check if a file is a .env file
  const isEnvFile = (file: File) => {
    const name = file.name.toLowerCase();
    return name === '.env' || 
           name.startsWith('.env.') || 
           name === 'env' || 
           name.startsWith('env.');
  };

  // Process dropped file
  const processFile = (file: File) => {
    if (!isEnvFile(file)) {
      return; // Only accept .env files
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      const parsedVars = parseEnvFile(content);
      
      if (parsedVars.length > 0) {
        const existingKeys = new Set(currentEnvVars.map(v => v.key));
        const newVars = parsedVars.filter(v => !existingKeys.has(v.key));
        updateEnvVars([...currentEnvVars, ...newVars]);
        maybeAutoApplyDetectedPort(parsedVars);
        setExpanded(true);
      }
    };
    reader.readAsText(file);
  };

  // Drag handlers
  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Check if dragged items contain files
    if (e.dataTransfer.items && e.dataTransfer.items.length > 0) {
      setIsDragging(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    
    // Only set dragging to false if we're leaving the component entirely
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX;
    const y = e.clientY;
    
    if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
      setIsDragging(false);
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Set the drop effect
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    
    // Process only .env files
    files.forEach(file => {
      if (isEnvFile(file)) {
        processFile(file);
      }
    });
  }, [processFile]);

  return (
    <div className={borderless ? '' : 'bg-card rounded-2xl border border-border/50'}>
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-500/10 flex items-center justify-center">
            <Key className="size-[18px] text-violet-500" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">{ev.title}</p>
            <p className="text-xs text-muted-foreground">
              {currentEnvVars.length === 0 ? ev.noneSet : interpolate(currentEnvVars.length === 1 ? t.importProject.counts.variableOne : t.importProject.counts.variableOther, { count: String(currentEnvVars.length) })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {mode === "settings" && !isEditingMode && (
            <>
              {/* Paste / Upload always available — clicking either
                  flips the section into edit mode and runs the action.
                  Matches the deploy-page UI so the operator doesn't
                  have to click Edit first just to dump in a .env. */}
              <button
                onClick={() => {
                  setIsEditingMode(true);
                  void handlePasteFromClipboard();
                }}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-foreground bg-muted/60 hover:bg-muted rounded-lg transition-colors"
              >
                <FileText className="size-3.5" />
                {ev.pasteEnv}
              </button>
              <button
                onClick={() => {
                  setIsEditingMode(true);
                  handleUploadClick();
                }}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-foreground bg-muted/60 hover:bg-muted rounded-lg transition-colors"
              >
                <Upload className="size-3.5" />
                {ev.uploadEnv}
              </button>
              <button
                onClick={() => setIsEditingMode(true)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-foreground bg-muted/60 hover:bg-muted rounded-lg transition-colors"
              >
                <Pencil className="size-3.5" />
                {ev.edit}
              </button>
            </>
          )}
          {mode === "settings" && isEditingMode && (
            <>
              {showSettingsActions && (
                <button
                  onClick={onCancel}
                  className="p-2 text-muted-foreground hover:text-danger hover:bg-danger-bg rounded-lg transition-colors"
                  title={ev.cancel}
                >
                  <X className="size-4" />
                </button>
              )}
              <button
                onClick={() => void handlePasteFromClipboard()}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-foreground bg-muted/60 hover:bg-muted rounded-lg transition-colors"
              >
                <FileText className="size-3.5" />
                {ev.pasteEnv}
              </button>
              <button
                onClick={handleUploadClick}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-foreground bg-muted/60 hover:bg-muted rounded-lg transition-colors"
              >
                <Upload className="size-3.5" />
                {ev.uploadEnv}
              </button>
              {showSettingsActions && (
                <button
                  onClick={onSave}
                  disabled={isSaving}
                  className="px-4 py-1.5 bg-primary text-primary-foreground text-xs font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSaving ? ev.saving : ev.saveChanges}
                </button>
              )}
            </>
          )}
          {mode === "deploy" && isEditingMode && (
            <>
              <button
                onClick={() => void handlePasteFromClipboard()}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-foreground bg-muted/60 hover:bg-muted rounded-lg transition-colors"
              >
                <FileText className="size-3.5" />
                {ev.pasteEnv}
              </button>
              <button
                onClick={handleUploadClick}
                className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-foreground bg-muted/60 hover:bg-muted rounded-lg transition-colors"
              >
                <Upload className="size-3.5" />
                {ev.uploadEnv}
              </button>
            </>
          )}
          {/* #336: reveal masked values. Only when a reveal source is wired
              (onRevealAll) and there's something masked, or already revealed. */}
          {onRevealAll && (hasMaskedRow || revealedValues) && (
            <button
              type="button"
              onClick={() => void toggleRevealAll()}
              disabled={revealing}
              className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-foreground bg-muted/60 hover:bg-muted rounded-lg transition-colors disabled:opacity-50"
              title={revealedValues ? ev.reveal?.hide : ev.reveal?.show}
            >
              {revealedValues ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              {revealedValues ? ev.reveal?.hide : ev.reveal?.show}
            </button>
          )}
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              aria-label={expanded ? ev.collapse : ev.expand}
            >
              {expanded ? (
                <ChevronUp className="size-4" />
              ) : (
                <ChevronDown className="size-4" />
              )}
            </button>
          )}
        </div>
      </div>
      
      <input
        ref={fileInputRef}
        type="file"
        accept=".env,.env.local,.env.production,.env.development,text/plain"
        onChange={handleFileUpload}
        className="hidden"
      />

      {expanded && (
      <div
        ref={pasteZoneRef}
        className={`px-5 pb-5 space-y-3 pt-4 transition-all ${
          borderless ? 'rounded-b-xl' : 'border-t border-border/50 rounded-b-2xl'
        } ${
          isDragging ? 'ring-2 ring-primary/30 bg-primary/5' : ''
        }`}
        tabIndex={isEditingMode ? 0 : -1}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onPasteCapture={handleContainerPaste}
        onClick={handlePasteZoneClick}
      >
        {currentEnvVars.map((env, index) => {
          const resolution = getEnvResolutionState(envMeta?.[env.key], env.value, t);
          const inputStateClass = resolution?.inputClass ?? "";
          return (
            <div key={index} data-env-index={index} className="space-y-1.5">
              {resolution && (
                <div className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${resolution.badgeClass}`}>
                  <EnvResolutionIcon icon={resolution.icon} />
                  {resolution.label}
                </div>
              )}
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={env.key}
                  onChange={(e) => handleKeyChange(index, e.target.value)}
                  placeholder="KEY"
                  readOnly={!isEditingMode}
                  className={`flex-1 px-3.5 py-2.5 border border-border/50 rounded-lg text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all ${
                    !isEditingMode ? 'cursor-default bg-muted/20' : 'bg-muted/30'
                  } ${inputStateClass}`}
                />
                <div className="relative flex-1">
                  {(() => {
                    // #336: masked rows display the revealed overlay value when
                    // shown; the underlying state stays the sentinel until edited
                    // (see revealedValues). Real/typed rows display their own value
                    // unchanged. Masked-row visibility is the local `shownKeys`
                    // overlay; plaintext rows keep their own `visible` flag.
                    const masked = isMaskedValue(env.value);
                    const showAsText = masked ? shownKeys.has(env.key) : env.visible;
                    const displayValue =
                      masked && revealedValues && env.key in revealedValues
                        ? revealedValues[env.key]
                        : env.value;
                    return (
                  <input
                    type={showAsText ? "text" : "password"}
                    value={displayValue}
                    onChange={(e) => handleValueChange(index, e.target.value)}
                    placeholder={ev.valuePlaceholder}
                    readOnly={!isEditingMode}
                    className={`w-full px-3.5 py-2.5 pe-9 border border-border/50 rounded-lg text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all ${
                      !isEditingMode ? 'cursor-default bg-muted/20' : 'bg-muted/30'
                    } ${inputStateClass}`}
                  />
                    );
                  })()}
                  <button
                    onClick={() => void toggleEnvVisibility(index)}
                    className="absolute end-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                    type="button"
                  >
                    {(isMaskedValue(env.value) ? shownKeys.has(env.key) : env.visible) ? (
                      <EyeOff className="size-3.5" />
                    ) : (
                      <Eye className="size-3.5" />
                    )}
                  </button>
                </div>

                {showEditControls && isEditingMode && (
                  <button
                    onClick={() => removeEnvVar(index)}
                    className="flex size-8 items-center justify-center rounded-lg text-muted-foreground/50 hover:text-danger hover:bg-danger-bg transition-colors"
                    type="button"
                    title={ev.delete}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
            </div>
          );
        })}

        {currentEnvVars.length === 0 && (
          <div
            className={`text-center flex flex-col items-center justify-center py-10 px-6 border-2 border-dashed rounded-xl transition-all ${
              isDragging
                ? 'border-primary bg-primary/5'
                : 'border-border/50 bg-muted/20'
            }`}
          >
            <Key className={`size-10 mb-3 ${isDragging ? 'text-primary' : 'text-muted-foreground/30'}`} />
            <p className={`text-sm font-medium mb-1 ${isDragging ? 'text-primary' : 'text-foreground'}`}>
              {isDragging ? ev.dropHere : ev.noneTitle}
            </p>
            <p className="text-xs text-muted-foreground max-w-xs">
              {isEditingMode
                ? ev.emptyHintEditing
                : ev.emptyHintReadonly}
            </p>
          </div>
        )}

        {isEditingMode && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {ev.pasteHint}
            </p>
            <div className="flex items-center gap-2">
            <button
              onClick={addEnvVar}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
            >
              <Plus className="size-3.5" />
              {ev.addVariable}
            </button>
            </div>
          </div>
        )}
      </div>
      )}
    </div>
  );
};

function parseEnvFile(content: string) {
  const lines = content.split(/\r?\n/);
  const parsed: EnvironmentVariableRow[] = [];

  lines.forEach((line) => {
    const trimmedLine = line.trim();
    if (!trimmedLine || trimmedLine.startsWith("#")) return;

    const equalIndex = trimmedLine.indexOf("=");
    if (equalIndex === -1) return;

    const key = trimmedLine.substring(0, equalIndex).trim();
    let value = trimmedLine.substring(equalIndex + 1).trim();

    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;

    if (value.startsWith('"')) {
      const closingQuoteIndex = value.indexOf('"', 1);
      value = closingQuoteIndex !== -1 ? value.substring(1, closingQuoteIndex) : value.substring(1);
    } else if (value.startsWith("'")) {
      const closingQuoteIndex = value.indexOf("'", 1);
      value = closingQuoteIndex !== -1 ? value.substring(1, closingQuoteIndex) : value.substring(1);
    } else {
      const commentMatch = value.match(/\s+#/);
      if (commentMatch && commentMatch.index !== undefined) {
        value = value.substring(0, commentMatch.index).trim();
      }
    }

    parsed.push({ key, value, visible: true });
  });

  return parsed;
}

function looksLikeEnvPaste(content: string, allowSingleLine: boolean) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim() && !line.trim().startsWith("#"));
  const envLines = lines.filter((line) => {
    const equalIndex = line.indexOf("=");
    if (equalIndex <= 0) return false;
    const key = line.substring(0, equalIndex).trim();
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
  });

  if (envLines.length >= 2) {
    return true;
  }

  return allowSingleLine && envLines.length === 1;
}

function getEnvRowIndexFromTarget(target: HTMLElement) {
  const row = target.closest<HTMLElement>("[data-env-index]");
  if (!row?.dataset.envIndex) return undefined;

  const index = Number(row.dataset.envIndex);
  return Number.isInteger(index) ? index : undefined;
}

function detectContainerPort(envVars: EnvironmentVariableRow[]) {
  const portValue = envVars.find((env) => env.key.trim().toUpperCase() === "PORT")?.value?.trim();
  if (!portValue || !/^\d+$/.test(portValue)) {
    return null;
  }

  const port = Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return String(port);
}

function getEnvResolutionState(meta: EnvironmentVariableMeta | undefined, value: string, t: Dictionary) {
  if (!meta) return null;
  const res = t.importProject.environmentVariables.resolution;

  if (meta.source === "missing" && !value) {
    return {
      icon: AlertTriangle,
      label: res.needsValue,
      badgeClass: "bg-warning-bg text-warning",
      inputClass: "border-warning-border bg-warning-bg focus:ring-warning-border",
    };
  }

  if (meta.source === "default" && value === meta.resolvedValue) {
    return {
      icon: RotateCcw,
      label: res.fallbackDefault,
      badgeClass: "bg-info-bg text-info",
      inputClass: "border-info-border bg-info-bg focus:ring-info-border",
    };
  }

  if (meta.source === "env-file" && value === meta.resolvedValue) {
    return {
      icon: FileText,
      label: res.loadedFromEnv,
      badgeClass: "bg-success-bg text-success",
      inputClass: "border-success-border bg-success-bg focus:ring-success-border",
    };
  }

  if (meta.source === "interpolated" && value === meta.resolvedValue) {
    return {
      icon: RotateCcw,
      label: res.interpolated,
      badgeClass: "bg-muted text-muted-foreground",
      inputClass: "border-border/70",
    };
  }

  return null;
}

function EnvResolutionIcon({ icon: Icon }: { icon: React.ComponentType<{ className?: string }> }) {
  return <Icon className="size-3" />;
}

export default React.memo(EnvironmentVariables);
