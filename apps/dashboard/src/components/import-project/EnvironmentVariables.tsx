"use client";
import React, { useCallback, useRef, useState } from "react";
import { Eye, EyeOff, Trash2, Plus, Upload, X, Key, Pencil } from "lucide-react";
import { useOptionalDeployment } from "@/context/DeploymentContext";
import { useToast } from "@/context/ToastContext";

interface EnvironmentVariablesPropsOptional {
  mode?: "deploy" | "settings";
  showEditControls?: boolean;
  isEditingMode?: boolean;
  setIsEditingMode?: (editing: boolean) => void;
  onSave?: () => void;
  onCancel?: () => void;
  hasChanges?: boolean;
  isSaving?: boolean;
  /** When true, removes the outer card border and inner divider — for embedding inside another card. */
  borderless?: boolean;
  // For settings mode - external env vars
  envVars?: Array<{ key: string; value: string; visible: boolean }>;
  onEnvVarsChange?: (envVars: Array<{ key: string; value: string; visible: boolean }>) => void;
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
  borderless = false,
  envVars: externalEnvVars,
  onEnvVarsChange,
}) => {
  const deployment = useOptionalDeployment();
  const { showToast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [internalIsEditingMode, setInternalIsEditingMode] = useState(mode === "deploy");
  
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
    : (newVars: Array<{ key: string; value: string; visible: boolean }>) => deployment?.updateConfig({ envVars: newVars });

  const addEnvVar = useCallback(() => {
    const newEnvVars = [...currentEnvVars, { key: "", value: "", visible: false }];
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

  // Smart paste: intercept paste in KEY/VALUE inputs, detect multi-line KEY=VALUE format
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLInputElement>, index: number) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;

    // Check if pasted text looks like env format (has at least one KEY=VALUE line)
    const lines = text.split('\n').filter(l => l.trim() && !l.trim().startsWith('#'));
    const envLines = lines.filter(l => {
      const eqIdx = l.indexOf('=');
      if (eqIdx <= 0) return false;
      const key = l.substring(0, eqIdx).trim();
      return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
    });

    // Only intercept if we detect multiple env lines, or a single KEY=VALUE that differs from a plain value
    if (envLines.length < 2 && (envLines.length === 0 || !text.includes('\n'))) return;

    e.preventDefault();

    const parsed = parseEnvFile(text);
    if (parsed.length === 0) return;

    // Merge: update existing keys, add new ones
    const existingMap = new Map(currentEnvVars.map((v, i) => [v.key, i]));
    const merged = [...currentEnvVars];

    // Remove the current empty row if it was the target of the paste
    const currentRow = merged[index];
    const isEmptyRow = currentRow && !currentRow.key && !currentRow.value;

    let added = 0;
    let updated = 0;
    for (const pv of parsed) {
      const existingIdx = existingMap.get(pv.key);
      if (existingIdx !== undefined) {
        merged[existingIdx] = { ...merged[existingIdx], value: pv.value };
        updated++;
      } else {
        merged.push(pv);
        added++;
      }
    }

    // Remove the empty row that triggered the paste
    if (isEmptyRow) {
      merged.splice(index, 1);
    }

    updateEnvVars(merged);

    const parts: string[] = [];
    if (added > 0) parts.push(`${added} added`);
    if (updated > 0) parts.push(`${updated} updated`);
    showToast(`Pasted ${parsed.length} variable${parsed.length !== 1 ? 's' : ''}${parts.length ? ` (${parts.join(', ')})` : ''}`, "success", "Environment Variables");
  }, [currentEnvVars, updateEnvVars, showToast]);

  const parseEnvFile = (content: string) => {
    const lines = content.split('\n');
    const parsed: Array<{ key: string; value: string; visible: boolean }> = [];

    lines.forEach((line) => {
      // Skip empty lines
      const trimmedLine = line.trim();
      if (!trimmedLine) return;

      // Skip comment lines (lines starting with #)
      if (trimmedLine.startsWith('#')) return;

      // Find the first = sign to split key and value
      const equalIndex = trimmedLine.indexOf('=');
      if (equalIndex === -1) return; // No = sign, skip this line

      // Extract key and value
      const key = trimmedLine.substring(0, equalIndex).trim();
      let value = trimmedLine.substring(equalIndex + 1).trim();

      // Validate key format (must start with letter or underscore, followed by alphanumeric or underscore)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return;

      // Handle quoted values
      if (value.startsWith('"')) {
        // Double-quoted value - find the closing quote
        const closingQuoteIndex = value.indexOf('"', 1);
        if (closingQuoteIndex !== -1) {
          value = value.substring(1, closingQuoteIndex);
        } else {
          // No closing quote, take everything after opening quote
          value = value.substring(1);
        }
      } else if (value.startsWith("'")) {
        // Single-quoted value - find the closing quote
        const closingQuoteIndex = value.indexOf("'", 1);
        if (closingQuoteIndex !== -1) {
          value = value.substring(1, closingQuoteIndex);
        } else {
          // No closing quote, take everything after opening quote
          value = value.substring(1);
        }
      } else {
        // Unquoted value - remove inline comments
        // Split by # but only if it's preceded by whitespace (to avoid breaking values with #)
        const commentMatch = value.match(/\s+#/);
        if (commentMatch && commentMatch.index !== undefined) {
          value = value.substring(0, commentMatch.index).trim();
        }
      }

      // Only add if we have a valid key (value can be empty)
      if (key) {
        parsed.push({ key, value, visible: false });
      }
    });

    return parsed;
  };

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
      }
    };
    reader.readAsText(file);
    
    // Reset input so same file can be uploaded again
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [updateEnvVars, currentEnvVars]);

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
  }, [currentEnvVars, updateEnvVars]);

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
            <button
              onClick={() => setIsEditingMode(true)}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
            >
              <Pencil className="size-3.5" />
              Edit
            </button>
          )}
          {mode === "settings" && isEditingMode && (
            <>
              <button
                onClick={onCancel}
                className="p-2 text-muted-foreground hover:text-red-500 hover:bg-red-500/10 rounded-lg transition-colors"
                title="Cancel"
              >
                <X className="size-4" />
              </button>
              <button
                onClick={handleUploadClick}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
              >
                <Upload className="size-3.5" />
                Upload .env
              </button>
              <button
                onClick={onSave}
                disabled={isSaving}
                className="px-4 py-1.5 bg-primary text-primary-foreground text-xs font-medium rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSaving ? 'Saving...' : 'Save Changes'}
              </button>
            </>
          )}
          {mode === "deploy" && isEditingMode && (
            <button
              onClick={handleUploadClick}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
            >
              <Upload className="size-3.5" />
              Upload .env
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

      <div
        className={`px-5 pb-5 space-y-3 pt-4 transition-all ${
          borderless ? 'rounded-b-xl' : 'border-t border-border/50 rounded-b-2xl'
        } ${
          isDragging ? 'ring-2 ring-primary/30 bg-primary/5' : ''
        }`}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {currentEnvVars.map((env, index) => (
          <div key={index} className="flex items-center gap-2">
            <input
              type="text"
              value={env.key}
              onChange={(e) => handleKeyChange(index, e.target.value)}
              onPaste={(e) => handlePaste(e, index)}
              placeholder="KEY"
              readOnly={!isEditingMode}
              className={`flex-1 px-3.5 py-2.5 border border-border/50 rounded-lg text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all ${
                !isEditingMode ? 'cursor-default bg-muted/20' : 'bg-muted/30'
              }`}
            />
            <div className="relative flex-1">
              <input
                type={env.visible ? "text" : "password"}
                value={env.value}
                onChange={(e) => handleValueChange(index, e.target.value)}
                onPaste={(e) => handlePaste(e, index)}
                placeholder="value"
                readOnly={!isEditingMode}
                className={`w-full px-3.5 py-2.5 pr-9 border border-border/50 rounded-lg text-sm font-mono text-foreground placeholder:text-muted-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all ${
                  !isEditingMode ? 'cursor-default bg-muted/20' : 'bg-muted/30'
                }`}
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
        ))}

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
                ? 'Click "Add Variable" below, "Upload .env", or drag and drop a .env file here'
                : 'Click "Edit" to manage environment variables'}
            </p>
          </div>
        )}

        {isEditingMode && (
          <div className="flex items-center gap-2">
            <button
              onClick={addEnvVar}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted rounded-lg transition-colors"
            >
              <Plus className="size-3.5" />
              Add Variable
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default React.memo(EnvironmentVariables);
