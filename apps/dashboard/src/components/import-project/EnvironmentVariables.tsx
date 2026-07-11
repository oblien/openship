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
import { useOptionalDeployment } from "@/context/DeploymentContext";
import { useToast } from "@/context/ToastContext";

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
}) => {
  const deployment = useOptionalDeployment();
  const { showToast } = useToast();
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

  const toggleEnvVisibility = useCallback(
    (index: number) => {
      const newEnvVars = currentEnvVars.map((env, i) =>
        i === index ? { ...env, visible: !env.visible } : env
      );
      updateEnvVars(newEnvVars);
    },
    [currentEnvVars, updateEnvVars]
  );

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
      if (added > 0) parts.push(`${added} added`);
      if (updated > 0) parts.push(`${updated} updated`);

      showToast(
        `Pasted ${parsedCount} variable${parsedCount !== 1 ? "s" : ""}${parts.length ? ` (${parts.join(", ")})` : ""}`,
        "success",
        "Environment Variables"
      );
    },
    [showToast]
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
      showToast(`Runtime port set to ${detectedPort} from PORT`, "success", "Environment Variables");
    },
    [deployment, mode, showToast]
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
        "Clipboard access is not available here. Click inside the environment box and paste with Cmd/Ctrl+V.",
        "error",
        "Environment Variables"
      );
      return;
    }

    try {
      const text = await navigator.clipboard.readText();

      if (!text.trim()) {
        showToast("Clipboard is empty", "error", "Environment Variables");
        return;
      }

      if (!looksLikeEnvPaste(text, true) || !applyEnvText(text)) {
        showToast(
          "Clipboard does not contain valid KEY=VALUE environment variables",
          "error",
          "Environment Variables"
        );
      } else {
        // Successful paste — reveal the body so the operator sees the
        // rows that just landed (no-op if not in collapsible mode).
        setExpanded(true);
      }
    } catch {
      showToast(
        "Clipboard access was blocked. Click inside the environment box and paste with Cmd/Ctrl+V.",
        "error",
        "Environment Variables"
      );
    }
  }, [applyEnvText, isEditingMode, showToast]);

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
            <p className="text-sm font-medium text-foreground">Environment Variables</p>
            <p className="text-xs text-muted-foreground">
              {currentEnvVars.length === 0 ? 'None set' : `${currentEnvVars.length} variable${currentEnvVars.length !== 1 ? 's' : ''}`}
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
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
              >
                <FileText className="size-3.5" />
                Paste .env
              </button>
              <button
                onClick={() => {
                  setIsEditingMode(true);
                  handleUploadClick();
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
              >
                <Upload className="size-3.5" />
                Upload .env
              </button>
              <button
                onClick={() => setIsEditingMode(true)}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
              >
                <Pencil className="size-3.5" />
                Edit
              </button>
            </>
          )}
          {mode === "settings" && isEditingMode && (
            <>
              {showSettingsActions && (
                <button
                  onClick={onCancel}
                  className="p-2 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                  title="Cancel"
                >
                  <X className="size-4" />
                </button>
              )}
              <button
                onClick={() => void handlePasteFromClipboard()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
              >
                <FileText className="size-3.5" />
                Paste .env
              </button>
              <button
                onClick={handleUploadClick}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
              >
                <Upload className="size-3.5" />
                Upload .env
              </button>
              {showSettingsActions && (
                <button
                  onClick={onSave}
                  disabled={isSaving}
                  className="px-4 py-1.5 bg-primary text-primary-foreground text-xs font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isSaving ? 'Saving...' : 'Save Changes'}
                </button>
              )}
            </>
          )}
          {mode === "deploy" && isEditingMode && (
            <>
              <button
                onClick={() => void handlePasteFromClipboard()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
              >
                <FileText className="size-3.5" />
                Paste .env
              </button>
              <button
                onClick={handleUploadClick}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
              >
                <Upload className="size-3.5" />
                Upload .env
              </button>
            </>
          )}
          {collapsible && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
              aria-label={expanded ? "Collapse environment variables" : "Expand environment variables"}
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
          const resolution = getEnvResolutionState(envMeta?.[env.key], env.value);
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
                  <input
                    type={env.visible ? "text" : "password"}
                    value={env.value}
                    onChange={(e) => handleValueChange(index, e.target.value)}
                    placeholder="value"
                    readOnly={!isEditingMode}
                    className={`w-full px-3.5 py-2.5 pr-9 border border-border/50 rounded-lg text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all ${
                      !isEditingMode ? 'cursor-default bg-muted/20' : 'bg-muted/30'
                    } ${inputStateClass}`}
                  />
                  <button
                    onClick={() => toggleEnvVisibility(index)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors"
                    type="button"
                  >
                    {env.visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </button>
                </div>

                {showEditControls && isEditingMode && (
                  <button
                    onClick={() => removeEnvVar(index)}
                    className="flex size-8 items-center justify-center rounded-lg text-muted-foreground/50 hover:text-red-500 hover:bg-red-500/10 transition-colors"
                    type="button"
                    title="Delete"
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
              {isDragging ? 'Drop .env file here' : 'No environment variables'}
            </p>
            <p className="text-xs text-muted-foreground max-w-xs">
              {isEditingMode
                ? 'Click "Add Variable", use "Paste .env", upload a file, or paste anywhere inside this box'
                : 'Click "Edit" to manage environment variables'}
            </p>
          </div>
        )}

        {isEditingMode && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Paste a full .env block anywhere inside this box.
            </p>
            <div className="flex items-center gap-2">
            <button
              onClick={addEnvVar}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
            >
              <Plus className="size-3.5" />
              Add Variable
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

function getEnvResolutionState(meta: EnvironmentVariableMeta | undefined, value: string) {
  if (!meta) return null;

  if (meta.source === "missing" && !value) {
    return {
      icon: AlertTriangle,
      label: "Needs value",
      badgeClass: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
      inputClass: "border-amber-400/70 bg-amber-500/5 focus:ring-amber-500/20",
    };
  }

  if (meta.source === "default" && value === meta.resolvedValue) {
    return {
      icon: RotateCcw,
      label: "Fallback default",
      badgeClass: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
      inputClass: "border-blue-400/50 bg-blue-500/5 focus:ring-blue-500/20",
    };
  }

  if (meta.source === "env-file" && value === meta.resolvedValue) {
    return {
      icon: FileText,
      label: "Loaded from .env",
      badgeClass: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
      inputClass: "border-emerald-400/50 bg-emerald-500/5 focus:ring-emerald-500/20",
    };
  }

  if (meta.source === "interpolated" && value === meta.resolvedValue) {
    return {
      icon: RotateCcw,
      label: "Interpolated",
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
