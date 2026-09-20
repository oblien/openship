"use client";
import React, { useCallback, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Download,
  Eye,
  EyeOff,
  FileText,
  Key,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { ENV_MASK, isMaskedValue, looksLikeSecretKey } from "@repo/core";
import { useOptionalDeployment } from "@/context/DeploymentContext";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import type { Dictionary } from "@/i18n";
import type { EnvironmentVariable } from "./types";
import { useDemoMode } from "@/lib/demo-mode";
import { parseDotenv, serializeDotenv } from "@/lib/dotenv";

// #336: env values arrive masked as ENV_MASK (shared with the API via @repo/core
// so the exact sentinel can't drift). A masked row keeps the sentinel in state —
// a save round-trips it and the backend restores the stored secret; "show
// values" reveals real values into a display-only overlay; editing a revealed
// row replaces the sentinel with the typed value.
type EnvironmentVariableRow = EnvironmentVariable & {
  sourceId?: string;
};

type EnvironmentVariableMeta = {
  source: "env-file" | "default" | "missing" | "interpolated";
  variable?: string;
  defaultValue?: string;
  resolvedValue: string;
  expression?: string;
  required?: boolean;
  unresolvedVariables?: string[];
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
  /** Hosts that already title the section — the compose / migration env modals,
   *  whose own header carries the service name, "Environment variables" and the
   *  count — hide the panel's icon + title so it isn't stated twice. */
  hideTitle?: boolean;
  // For settings mode - external env vars
  envVars?: EnvironmentVariableRow[];
  envMeta?: Record<string, EnvironmentVariableMeta>;
  onEnvVarsChange?: (envVars: EnvironmentVariableRow[]) => void;
  /**
   * Whether to show the secret toggle button on each row.
   * When true, operators can explicitly mark/unmark variables as secret.
   */
  showSecretToggle?: boolean;
  /**
   * #336: fetch the REAL (unmasked) values for EXACTLY `keys` — one row's eye
   * asks for that one key; "Show values" and "Download .env" ask for all masked keys.
   * Never a "give me everything" call: the API requires the key names, so a
   * single reveal discloses a single secret. When provided and any row is masked
   * (`••••••••`), the reveal affordances appear. Omit when there's no reveal
   * source (for example, rows the user typed) — masked rows then have no reveal.
   */
  onReveal?: (keys: string[]) => Promise<Record<string, string>>;
}

const EnvironmentVariables: React.FC<EnvironmentVariablesPropsOptional> = ({
  mode = "deploy",
  showEditControls = true,
  isEditingMode: externalIsEditingMode,
  showSecretToggle = false,
  setIsEditingMode: externalSetIsEditingMode,
  onSave,
  onCancel,
  hasChanges,
  isSaving = false,
  showSettingsActions = true,
  borderless = false,
  collapsible = false,
  hideTitle = false,
  envVars: externalEnvVars,
  envMeta,
  onEnvVarsChange,
  onReveal,
}) => {
  const demoMode = useDemoMode();
  const deployment = useOptionalDeployment();
  const { showToast } = useToast();
  const { t } = useI18n();
  const ev = t.importProject.environmentVariables;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pasteZoneRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const downloadInFlight = useRef(false);
  const [internalIsEditingMode, setInternalIsEditingMode] = useState(mode === "deploy");
  // Body starts hidden when `collapsible` is set. Auto-expanded by the
  // paste / upload handlers below so the user sees parsed rows land
  // without an extra click.
  const [expanded, setExpanded] = useState(!collapsible);

  // Use external state if provided, otherwise use internal state
  const isEditingMode =
    externalIsEditingMode !== undefined ? externalIsEditingMode : internalIsEditingMode;
  const setIsEditingMode = externalSetIsEditingMode || setInternalIsEditingMode;

  // Use external env vars in settings mode, deployment context in deploy mode
  if (mode === "deploy" && !deployment) {
    throw new Error("EnvironmentVariables in deploy mode must be used within DeploymentProvider");
  }

  const currentEnvVars =
    mode === "settings" ? (externalEnvVars ?? []) : (deployment?.config.envVars ?? []);

  const updateEnvVars =
    mode === "settings" && onEnvVarsChange
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
    [currentEnvVars, updateEnvVars],
  );

  const updateEnvVar = useCallback(
    (index: number, field: keyof (typeof currentEnvVars)[0], value: string | boolean) => {
      const newEnvVars = currentEnvVars.map((env, i) =>
        i === index ? { ...env, [field]: value } : env,
      );
      updateEnvVars(newEnvVars);
    },
    [currentEnvVars, updateEnvVars],
  );

  const toggleSecret = useCallback(
    (index: number) => {
      const env = currentEnvVars[index];
      if (!env) return;
      const currentSecret = env.isSecret ?? looksLikeSecretKey(env.key);
      const nextSecret = !currentSecret;
      const newEnvVars = currentEnvVars.map((item, i) =>
        i === index ? { ...item, isSecret: nextSecret, visible: !nextSecret } : item,
      );
      updateEnvVars(newEnvVars);
    },
    [currentEnvVars, updateEnvVars],
  );

  // #336: display-only overlay of revealed real values (keyed by env key). Kept
  // out of `currentEnvVars` on purpose: the row value stays the mask sentinel
  // until the user actually edits it, so revealing never marks the form dirty
  // and a save still round-trips the sentinel (backend keeps the stored secret).
  // Fills in per key — a row's eye only ever puts THAT row's secret in here.
  const [revealedValues, setRevealedValues] = useState<Record<string, string>>({});
  // Which masked rows are currently SHOWN as text, keyed by env key — a local
  // overlay, NOT the row's `visible` field. A masked row's value is a sentinel, so
  // its visibility is a pure display concern; routing it through `updateEnvVars`
  // would (a) mark the form dirty and (b) silently drop in the migration editor,
  // whose Record<string,string> bridge (envToRows/rowsToEnv) can't carry `visible`.
  // Keeping it here makes the eye work identically in every host.
  const [shownKeys, setShownKeys] = useState<Set<string>>(() => new Set());
  const [revealingKeys, setRevealingKeys] = useState<Set<string>>(() => new Set());
  const maskedKeys = currentEnvVars
    .filter((env) => env.preserveValue || isMaskedValue(env.value))
    .map((env) => env.key);
  const hasMaskedRow = maskedKeys.length > 0;
  // Every masked row shown → the header flips to "Hide values". Until then it
  // reads "Show values" and fetches whatever is still hidden, so the pair is
  // monotone: show-all → hide-all, with no dead end after a single row's eye.
  const allShown = hasMaskedRow && maskedKeys.every((key) => shownKeys.has(key));

  // Fetch plaintext for EXACTLY `keys`, minus what's already in the overlay. The
  // ref holds one in-flight promise per key, so a rapid double-click — or the
  // header racing a row's eye — shares a request instead of re-asking the server
  // for the same secret. Rejects (after toasting) so callers bail without
  // surfacing a second error; resolves null when no reveal source is wired.
  const inFlightRef = useRef<Map<string, Promise<Record<string, string>>>>(new Map());
  const ensureRevealed = useCallback(
    async (keys: string[]): Promise<Record<string, string> | null> => {
      if (!onReveal) return null;
      const known: Record<string, string> = {};
      const pending: Promise<Record<string, string>>[] = [];
      const toFetch: string[] = [];
      for (const key of keys) {
        // hasOwn, not `in`: an env var named `constructor` would otherwise "hit"
        // the overlay and hand back a function off Object.prototype.
        if (Object.hasOwn(revealedValues, key)) known[key] = revealedValues[key];
        else {
          const inFlight = inFlightRef.current.get(key);
          if (inFlight) pending.push(inFlight);
          else toFetch.push(key);
        }
      }
      if (toFetch.length > 0) {
        const request = onReveal(toFetch)
          .then((vals) => {
            setRevealedValues((prev) => ({ ...prev, ...vals }));
            return vals;
          })
          .catch((err) => {
            showToast(ev.reveal?.error ?? "Failed to reveal values", "error", ev.toast.title);
            throw err;
          })
          .finally(() => {
            for (const key of toFetch) inFlightRef.current.delete(key);
            setRevealingKeys((prev) => {
              const next = new Set(prev);
              for (const key of toFetch) next.delete(key);
              return next;
            });
          });
        for (const key of toFetch) inFlightRef.current.set(key, request);
        setRevealingKeys((prev) => new Set([...prev, ...toFetch]));
        pending.push(request);
      }
      if (pending.length === 0) return known;
      return Object.assign(known, ...(await Promise.all(pending)));
    },
    [revealedValues, onReveal, showToast, ev],
  );

  // Reveal `keys` and show exactly the ones that came back. A key the source no
  // longer has stays masked — displaying the sentinel as "plaintext" would be a
  // lie — and the operator gets the error toast.
  const revealAndShow = useCallback(
    async (keys: string[]) => {
      const vals = await ensureRevealed(keys).catch(() => null);
      if (!vals) return;
      const got = keys.filter((key) => Object.hasOwn(vals, key));
      if (got.length < keys.length) {
        showToast(ev.reveal?.error ?? "Failed to reveal values", "error", ev.toast.title);
      }
      if (got.length > 0) setShownKeys((prev) => new Set([...prev, ...got]));
    },
    [ensureRevealed, showToast, ev],
  );

  // Drop plaintext for `keys` from the overlay as they're hidden, so a revealed
  // secret doesn't linger in component state after the operator hides it. Showing
  // it again re-fetches (per key) — one round trip is worth not holding it.
  const hideKeys = useCallback((keys: string[]) => {
    const dropped = new Set(keys);
    setShownKeys((prev) => new Set([...prev].filter((key) => !dropped.has(key))));
    setRevealedValues((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([key]) => !dropped.has(key))),
    );
  }, []);

  // The per-row eye. A masked row holds only the sentinel, so showing it fetches
  // THAT key's real value (nothing else) into the overlay. A plaintext row (new /
  // already-typed) is the plain local password/text flip on its own `visible` field.
  const toggleEnvVisibility = useCallback(
    async (index: number) => {
      const target = currentEnvVars[index];
      if (!target) return;
      if (target.preserveValue || isMaskedValue(target.value)) {
        if (shownKeys.has(target.key)) hideKeys([target.key]);
        else await revealAndShow([target.key]);
        return;
      }
      updateEnvVars(
        currentEnvVars.map((env, i) => (i === index ? { ...env, visible: !env.visible } : env)),
      );
    },
    [currentEnvVars, updateEnvVars, shownKeys, hideKeys, revealAndShow],
  );

  // Header "Show values" / "Hide values": an explicit bulk action. Hiding
  // clears the overlay so nothing is left exposed.
  const toggleRevealAll = useCallback(async () => {
    if (allShown) {
      hideKeys(maskedKeys);
      return;
    }
    await revealAndShow(maskedKeys);
  }, [allShown, maskedKeys, hideKeys, revealAndShow]);

  const handleKeyChange = (index: number, value: string) => {
    // Keep preserveValue until the VALUE is actually edited. The env planner
    // can then reject a masked-secret rename/classification change instead of
    // mistaking the blank display value for the user's intent.
    updateEnvVars(
      currentEnvVars.map((env, i) =>
        i === index ? { ...env, key: value } : env,
      ),
    );
  };

  const handleValueChange = (index: number, value: string) => {
    const row = currentEnvVars[index];
    if (row?.preserveValue) {
      updateEnvVars(
        currentEnvVars.map((env, i) =>
          i === index ? { ...env, value, preserveValue: false, visible: true } : env,
        ),
      );
      return;
    }
    // Editing a REVEALED row turns it into a plaintext row, which reads visibility
    // from its own `visible` flag instead of `shownKeys` — so carry the shown state
    // over, or the value the operator is typing flips back to dots mid-keystroke in
    // any host whose rows start `visible: false` (the migration wizard's do).
    if (row && isMaskedValue(row.value) && shownKeys.has(row.key)) {
      updateEnvVars(
        currentEnvVars.map((env, i) => (i === index ? { ...env, value, visible: true } : env)),
      );
      return;
    }
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
          merged[existingIdx] = {
            ...merged[existingIdx],
            value: nextVar.value,
            preserveValue: false,
          };
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
    [currentEnvVars, updateEnvVars],
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
        ev.toast.title,
      );
    },
    [showToast, ev],
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
    [deployment, mode, showToast, ev],
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
    [maybeAutoApplyDetectedPort, mergeParsedEnvVars, showEnvPasteResult],
  );

  const handleContainerPaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      if (!isEditingMode) return;

      const text = e.clipboardData.getData("text");
      if (!text) return;

      const target = e.target instanceof HTMLElement ? e.target : null;
      const isTextInputPaste = Boolean(
        target?.closest("input, textarea, [contenteditable='true']"),
      );

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
    [applyEnvText, currentEnvVars, isEditingMode],
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
      showToast(ev.toast.clipboardUnavailable, "error", ev.toast.title);
      return;
    }

    try {
      const text = await navigator.clipboard.readText();

      if (!text.trim()) {
        showToast(ev.toast.clipboardEmpty, "error", ev.toast.title);
        return;
      }

      if (!looksLikeEnvPaste(text, true) || !applyEnvText(text)) {
        showToast(ev.toast.clipboardInvalid, "error", ev.toast.title);
      } else {
        // Successful paste — reveal the body so the operator sees the
        // rows that just landed (no-op if not in collapsible mode).
        setExpanded(true);
      }
    } catch {
      showToast(ev.toast.clipboardBlocked, "error", ev.toast.title);
    }
  }, [applyEnvText, isEditingMode, showToast, ev]);

  const handlePasteZoneClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (!isEditingMode) return;

      const target = e.target as HTMLElement;
      if (target.closest("input, button, a, select, textarea, label")) {
        return;
      }

      pasteZoneRef.current?.focus();
    },
    [isEditingMode],
  );

  const handleFileUpload = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = (e) => {
        const content = e.target?.result as string;
        const parsedVars = parseEnvFile(content);

        if (parsedVars.length > 0) {
          // Merge with existing vars, avoiding duplicates
          const existingKeys = new Set(currentEnvVars.map((v) => v.key));
          const newVars = parsedVars.filter((v) => !existingKeys.has(v.key));
          updateEnvVars([...currentEnvVars, ...newVars]);
          maybeAutoApplyDetectedPort(parsedVars);
          setExpanded(true);
        }
      };
      reader.readAsText(file);

      // Reset input so same file can be uploaded again
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    },
    [currentEnvVars, maybeAutoApplyDetectedPort, updateEnvVars],
  );

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  const downloadableRows = currentEnvVars.filter((row) => row.key.trim());
  const handleDownload = async () => {
    if (downloadInFlight.current || isSaving || downloadableRows.length === 0) return;
    downloadInFlight.current = true;
    setIsDownloading(true);
    try {
      const keys = [
        ...new Set(
          downloadableRows
            .filter((row) => row.preserveValue || isMaskedValue(row.value))
            .map((row) => row.originalKey ?? row.key.trim()),
        ),
      ];
      // Download is an explicit reveal. Keep plaintext local to the export so
      // it neither exposes values in the form nor changes its saved-value masks.
      const revealed = keys.length > 0 && onReveal ? await onReveal(keys) : {};
      const rows = downloadableRows.map((row) => {
        let value: string | undefined = row.value;
        if (row.preserveValue || isMaskedValue(row.value)) {
          const key = row.originalKey ?? row.key.trim();
          value = Object.hasOwn(revealed, key) ? revealed[key] : undefined;
        }
        if (typeof value !== "string" || isMaskedValue(value)) {
          throw new Error("A saved environment value could not be retrieved");
        }
        return { key: row.key, value };
      });
      const blob = new Blob([serializeDotenv(rows)], { type: "text/plain;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = ".env";
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch {
      showToast(ev.toast.downloadFailed, "error", ev.toast.title);
    } finally {
      downloadInFlight.current = false;
      setIsDownloading(false);
    }
  };

  // Check if a file is a .env file
  const isEnvFile = (file: File) => {
    const name = file.name.toLowerCase();
    return name === ".env" || name.startsWith(".env.") || name === "env" || name.startsWith("env.");
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
        const existingKeys = new Set(currentEnvVars.map((v) => v.key));
        const newVars = parsedVars.filter((v) => !existingKeys.has(v.key));
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
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = Array.from(e.dataTransfer.files);

      // Process only .env files
      files.forEach((file) => {
        if (isEnvFile(file)) {
          processFile(file);
        }
      });
    },
    [processFile],
  );

  // One class for every secondary toolbar action.
  const actionBtn =
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-muted/60 px-3 text-xs font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50";
  const downloadAction = (
    <button
      type="button"
      onClick={() => void handleDownload()}
      disabled={isDownloading || isSaving || downloadableRows.length === 0}
      className={actionBtn}
    >
      {isDownloading ? (
        <LoaderCircle className="size-3.5 animate-spin" />
      ) : (
        <Download className="size-3.5" />
      )}
      {ev.downloadEnv}
    </button>
  );
  // With `hideTitle` the row can end up empty — don't render a bare 56px gap.
  const hasHeaderActions =
    mode === "settings" ||
    (mode === "deploy" && isEditingMode) ||
    (Boolean(onReveal) && hasMaskedRow) ||
    collapsible;

  return (
    <div className={borderless ? "" : "bg-card rounded-2xl border border-border/50"}>
      {(!hideTitle || hasHeaderActions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          {!hideTitle && (
            <div className="flex min-w-0 items-center gap-3">
              <div className="size-9 shrink-0 rounded-xl bg-violet-500/10 flex items-center justify-center">
                <Key className="size-[18px] text-violet-500" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{ev.title}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {currentEnvVars.length === 0
                    ? ev.noneSet
                    : interpolate(
                        currentEnvVars.length === 1
                          ? t.importProject.counts.variableOne
                          : t.importProject.counts.variableOther,
                        { count: String(currentEnvVars.length) },
                      )}
                </p>
              </div>
            </div>
          )}
          <div className="ms-auto flex flex-wrap items-center justify-end gap-2">
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
                  className={actionBtn}
                >
                  <FileText className="size-3.5" />
                  {ev.pasteEnv}
                </button>
                <button
                  onClick={() => {
                    setIsEditingMode(true);
                    handleUploadClick();
                  }}
                  className={actionBtn}
                >
                  <Upload className="size-3.5" />
                  {ev.uploadEnv}
                </button>
                {downloadAction}
                <button onClick={() => setIsEditingMode(true)} className={actionBtn}>
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
                <button onClick={() => void handlePasteFromClipboard()} className={actionBtn}>
                  <FileText className="size-3.5" />
                  {ev.pasteEnv}
                </button>
                <button onClick={handleUploadClick} className={actionBtn}>
                  <Upload className="size-3.5" />
                  {ev.uploadEnv}
                </button>
                {downloadAction}
                {showSettingsActions && (
                  <button
                    onClick={onSave}
                    disabled={isSaving}
                    className="inline-flex h-8 shrink-0 items-center rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isSaving ? ev.saving : ev.saveChanges}
                  </button>
                )}
              </>
            )}
            {mode === "deploy" && isEditingMode && (
              <>
                <button onClick={() => void handlePasteFromClipboard()} className={actionBtn}>
                  <FileText className="size-3.5" />
                  {ev.pasteEnv}
                </button>
                <button onClick={handleUploadClick} className={actionBtn}>
                  <Upload className="size-3.5" />
                  {ev.uploadEnv}
                </button>
                {downloadAction}
              </>
            )}
            {/* Bulk reveal is available when a source is wired and something is masked. */}
            {onReveal && hasMaskedRow && (
              <button
                type="button"
                onClick={() => void toggleRevealAll()}
                disabled={revealingKeys.size > 0}
                className={actionBtn}
                title={allShown ? ev.reveal?.hide : ev.reveal?.show}
              >
                {allShown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                {allShown ? ev.reveal?.hide : ev.reveal?.show}
              </button>
            )}
            {collapsible && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                className="flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                aria-label={expanded ? ev.collapse : ev.expand}
              >
                {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
              </button>
            )}
          </div>
        </div>
      )}

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
            borderless ? "rounded-b-xl" : "border-t border-border/50 rounded-b-2xl"
          } ${isDragging ? "ring-2 ring-primary/30 bg-primary/5" : ""}`}
          tabIndex={isEditingMode ? 0 : -1}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onPasteCapture={handleContainerPaste}
          onClick={handlePasteZoneClick}
        >
          {currentEnvVars.map((env, index) => {
            const resolution = getEnvResolutionState(
              envMeta?.[env.key],
              env.preserveValue ? ENV_MASK : env.value,
              t,
            );
            const inputStateClass = resolution?.inputClass ?? "";
            // #336: a masked row holds only the sentinel — the real value arrives in
            // the overlay when THAT key is revealed, and its visibility lives in
            // `shownKeys`. A plaintext row (new / typed) shows its own value and keeps
            // its own `visible` flag. Masked with no reveal source wired: no eye at
            // all, since the toggle could only ever display the sentinel as text.
            const masked = Boolean(env.preserveValue) || isMaskedValue(env.value);
            const showAsText = masked ? shownKeys.has(env.key) : env.visible;
            const displayValue =
              masked && Object.hasOwn(revealedValues, env.key)
                ? revealedValues[env.key]
                : env.preserveValue
                  ? ""
                  : env.value;
            const canToggleValue = !masked || Boolean(onReveal);
            const isSecret = env.isSecret ?? looksLikeSecretKey(env.key);
            return (
              <div key={index} data-env-index={index} className="space-y-1.5">
                {resolution && (
                  <div
                    className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium ${resolution.badgeClass}`}
                  >
                    <EnvResolutionIcon icon={resolution.icon} />
                    {resolution.label}
                  </div>
                )}
                <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                  <input
                    type="text"
                    value={env.key}
                    onChange={(e) => handleKeyChange(index, e.target.value)}
                    placeholder="KEY"
                    readOnly={!isEditingMode}
                    className={`w-full min-w-0 flex-none px-3.5 py-2.5 border border-border/50 rounded-lg text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all sm:w-auto sm:flex-1 ${
                      !isEditingMode ? "cursor-default bg-muted/20" : "bg-muted/30"
                    } ${inputStateClass}`}
                  />
                  <div className="relative min-w-0 flex-1">
                    <input
                      type={showAsText ? "text" : "password"}
                      value={displayValue}
                      onChange={(e) => handleValueChange(index, e.target.value)}
                      placeholder={env.preserveValue ? ENV_MASK : ev.valuePlaceholder}
                      readOnly={!isEditingMode}
                      className={`w-full px-3.5 py-2.5 pe-9 border border-border/50 rounded-lg text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all ${
                        !isEditingMode ? "cursor-default bg-muted/20" : "bg-muted/30"
                      } ${inputStateClass} ${demoMode ? "blur-[5px] select-none" : ""}`}
                    />
                    {canToggleValue && (
                      <button
                        onClick={() => void toggleEnvVisibility(index)}
                        disabled={revealingKeys.has(env.key)}
                        aria-busy={revealingKeys.has(env.key)}
                        aria-label={showAsText ? t.projectSettings.envVars.hideValue : t.projectSettings.envVars.showValue}
                        className="absolute end-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50 hover:text-muted-foreground transition-colors disabled:opacity-40"
                        type="button"
                      >
                        {revealingKeys.has(env.key) ? (
                          <LoaderCircle className="size-3.5 animate-spin" />
                        ) : showAsText ? (
                          <EyeOff className="size-3.5" />
                        ) : (
                          <Eye className="size-3.5" />
                        )}
                      </button>
                    )}
                  </div>

                  {showSecretToggle && (
                    <button
                      type="button"
                      disabled={!isEditingMode}
                      onClick={() => toggleSecret(index)}
                      title={
                        isSecret
                          ? t.projectSettings.envVars.markedSecret
                          : t.projectSettings.envVars.markSecret
                      }
                      aria-label={
                        isSecret
                          ? t.projectSettings.envVars.markedSecret
                          : t.projectSettings.envVars.markSecret
                      }
                      className={`flex size-8 shrink-0 items-center justify-center rounded-lg border transition-colors ${
                        isSecret
                          ? "border-warning-border bg-warning-bg text-warning"
                          : "border-border/60 bg-muted/30 text-muted-foreground hover:bg-muted/50"
                      } ${!isEditingMode ? "opacity-60 cursor-default" : ""}`}
                    >
                      <KeyRound className="size-3.5" />
                    </button>
                  )}

                  {showEditControls && isEditingMode && (
                    <button
                      onClick={() => removeEnvVar(index)}
                      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground/50 hover:text-danger hover:bg-danger-bg transition-colors"
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

          {/* The box holds the add CTA but is NOT itself a button: clicking its empty
            space focuses the paste zone, the documented fallback for when the
            clipboard API is blocked (see the clipboardBlocked toast). */}
          {currentEnvVars.length === 0 && (
            <div
              className={`flex flex-col items-center justify-center rounded-xl border border-dashed px-6 py-8 text-center transition-colors ${
                isDragging ? "border-primary bg-primary/5" : "border-border/60 bg-muted/15"
              }`}
            >
              <div
                className={`mb-3 flex size-10 items-center justify-center rounded-xl transition-colors ${
                  isDragging ? "bg-primary/10 text-primary" : "bg-muted/60 text-muted-foreground"
                }`}
              >
                <Key className="size-[18px]" />
              </div>
              <p
                className={`text-sm font-medium ${isDragging ? "text-primary" : "text-foreground"}`}
              >
                {isDragging ? ev.dropHere : ev.noneTitle}
              </p>
              <p className="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                {isEditingMode ? ev.emptyHintEditing : ev.emptyHintReadonly}
              </p>
              {isEditingMode && (
                <button
                  type="button"
                  onClick={addEnvVar}
                  className="mt-4 inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  <Plus className="size-3.5" />
                  {ev.addVariable}
                </button>
              )}
            </div>
          )}

          {isEditingMode && currentEnvVars.length > 0 && (
            <div className="space-y-2 pt-1">
              <button
                type="button"
                onClick={addEnvVar}
                className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border/60 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:bg-muted/30 hover:text-foreground"
              >
                <Plus className="size-3.5" />
                {ev.addVariable}
              </button>
              <p className="text-[11px] text-muted-foreground">{ev.pasteHint}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

function parseEnvFile(content: string) {
  return parseDotenv(content).map((row) => ({ ...row, visible: true }));
}

function looksLikeEnvPaste(content: string, allowSingleLine: boolean) {
  const lines = content
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"));
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

function getEnvResolutionState(
  meta: EnvironmentVariableMeta | undefined,
  value: string,
  t: Dictionary,
) {
  if (!meta) return null;
  const res = t.importProject.environmentVariables.resolution;

  if (meta.required || (meta.source === "missing" && !value)) {
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
