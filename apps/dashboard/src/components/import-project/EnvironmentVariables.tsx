"use client";
import React, { useCallback, useRef, useState } from "react";
import { generateIcon } from "@/utils/icons";
import { useDeployment } from "@/context/DeploymentContext";

interface EnvironmentVariablesPropsOptional {
  mode?: "deploy" | "settings";
  showEditControls?: boolean;
  isEditingMode?: boolean;
  setIsEditingMode?: (editing: boolean) => void;
  onSave?: () => void;
  onCancel?: () => void;
  hasChanges?: boolean;
  isSaving?: boolean;
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
  envVars: externalEnvVars,
  onEnvVarsChange,
}) => {
  const { config, updateConfig } = useDeployment();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [internalIsEditingMode, setInternalIsEditingMode] = useState(mode === "deploy");
  
  // Use external state if provided, otherwise use internal state
  const isEditingMode = externalIsEditingMode !== undefined ? externalIsEditingMode : internalIsEditingMode;
  const setIsEditingMode = externalSetIsEditingMode || setInternalIsEditingMode;

  // Use external env vars in settings mode, deployment context in deploy mode
  const currentEnvVars = mode === "settings" && externalEnvVars ? externalEnvVars : config.envVars;
  const updateEnvVars = mode === "settings" && onEnvVarsChange ? onEnvVarsChange : 
    (newVars: Array<{ key: string; value: string; visible: boolean }>) => updateConfig({ envVars: newVars });

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
    <div className="bg-white rounded-xl border border-gray-200 p-6 mb-10">
      <div className="flex items-center justify-between mb-6">
        <h2 
          className="font-normal text-black"
          style={{ fontSize: '1.35rem' }}
        >
          Environment Variables
        </h2>
        <div className="flex items-center gap-2">
          {mode === "settings" && !isEditingMode && (
            <button
              onClick={() => setIsEditingMode(true)}
              className="flex items-center gap-2 px-4 py-2 bg-white border text-black/50 hover:text-black text-sm font-normal rounded-xl hover:border-black transition-all"
              style={{
                borderColor: '#e2e8f0',
                borderRadius: '18px',
              }}
            >
              {generateIcon('pen-411-1658238246.png', 20, 'currentColor')}
              <span>Edit</span>
            </button>
          )}
          {mode === "settings" && isEditingMode && (
            <>
              <button
                onClick={onCancel}
                className="p-2 text-black/50 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all"
                title="Cancel"
              >
                {generateIcon('close%20remove-802-1662363936.png', 20, 'currentColor')}
              </button>
              <button
                onClick={handleUploadClick}
                className="flex items-center gap-2 px-4 py-2 bg-white border text-black hover:text-black text-sm font-normal rounded-xl hover:border-black transition-all"
                style={{
                  borderColor: '#e2e8f0',
                  borderRadius: '18px',
                }}
              >
                { generateIcon('Upload_uZvcsm1OqhVwR8BruGgMmeM2HaZoUOb0YqM8.png', 18, 'currentColor') }
                <span>Upload .env</span>
              </button>
              <button
                onClick={onSave}
                disabled={isSaving}
                className="flex items-center gap-2 px-5 py-2.5 bg-black text-white font-normal transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
                style={{
                  background: hasChanges ? 'var(--button-primary)' : '#gray',
                  borderRadius: '18px',
                  fontSize: '0.95rem',
                }}
                onMouseEnter={(e) => {
                  if (hasChanges && !isSaving) {
                    e.currentTarget.style.background = 'linear-gradient(135deg, #222, #444)';
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.boxShadow = '0 8px 20px rgba(0, 0, 0, 0.15)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (hasChanges && !isSaving) {
                    e.currentTarget.style.background = 'var(--button-primary)';
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'none';
                  }
                }}
              >
                <span>{isSaving ? 'Saving...' : 'Save Changes'}</span>
              </button>
            </>
          )}
          {mode === "deploy" && isEditingMode && (
            <>
              <button
                onClick={handleUploadClick}
                className="flex items-center gap-2 px-4 py-2 bg-white border text-black hover:text-black text-sm font-normal rounded-xl hover:border-black transition-all"
                style={{
                  borderColor: '#e2e8f0',
                  borderRadius: '18px',
                }}
              >
                { generateIcon('Upload_uZvcsm1OqhVwR8BruGgMmeM2HaZoUOb0YqM8.png', 18, 'currentColor') }
                <span>Upload .env</span>
              </button>
            </>
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
        className="space-y-3 rounded-xl transition-all p-4"
        style={{
          border: isDragging ? '2px solid #36b37e' : 'none',
          backgroundColor: isDragging ? 'rgba(54, 179, 126, 0.05)' : 'transparent',
          boxShadow: isDragging ? '0 5px 20px rgba(54, 179, 126, 0.15)' : 'none',
        }}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {currentEnvVars.map((env, index) => {
          return (
            <div key={index} className="flex gap-3 items-start">
              <div className="flex-1">
                <input
                  type="text"
                  value={env.key}
                  onChange={(e) => handleKeyChange(index, e.target.value)}
                  placeholder="KEY_NAME"
                  readOnly={!isEditingMode}
                  className="w-full px-4 py-3 bg-white border outline-none text-black  transition-all duration-200"
                  style={{
                    borderColor: '#f0f0f0',
                    borderRadius: '18px',
                    fontSize: '1.05rem',
                    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.02)',
                    cursor: !isEditingMode ? 'default' : 'text',
                    backgroundColor: !isEditingMode ? '#fafafa' : 'white',
                  }}
                  onFocus={(e) => {
                    if (isEditingMode) {
                      e.currentTarget.style.borderColor = '#36b37e';
                      e.currentTarget.style.boxShadow = '0 5px 20px rgba(54, 179, 126, 0.15)';
                    }
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = '#f0f0f0';
                    e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.02)';
                  }}
                />
              </div>
              <div className="flex-1">
                <div className="relative">
                  <input
                    type={env.visible ? "text" : "password"}
                    value={env.value}
                    onChange={(e) => handleValueChange(index, e.target.value)}
                    placeholder="value"
                    readOnly={!isEditingMode}
                    className="w-full px-4 py-3 pr-11 bg-white border outline-none text-black  transition-all duration-200"
                    style={{
                      borderColor: '#f0f0f0',
                      borderRadius: '18px',
                      fontSize: '1.05rem',
                      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.02)',
                      cursor: !isEditingMode ? 'default' : 'text',
                      backgroundColor: !isEditingMode ? '#fafafa' : 'white',
                    }}
                    onFocus={(e) => {
                      if (isEditingMode) {
                        e.currentTarget.style.borderColor = '#36b37e';
                        e.currentTarget.style.boxShadow = '0 5px 20px rgba(54, 179, 126, 0.15)';
                      }
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = '#f0f0f0';
                      e.currentTarget.style.boxShadow = '0 2px 8px rgba(0, 0, 0, 0.02)';
                    }}
                  />
                  <button
                    onClick={() => toggleEnvVisibility(index)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-black transition-colors p-1 rounded-lg hover:bg-gray-100"
                    type="button"
                  >
                    {env.visible ? (
                      generateIcon('hide-33-1691989601.png', 20, 'currentColor')
                    ) : (
                      generateIcon('Eye_vsFHLJrbkKv9lf6nic8FhE340LfLNdM8ffBe.png', 20, 'currentColor')
                    )}
                  </button>
                </div>
              </div>
              
              {showEditControls && isEditingMode && (
                <button
                  onClick={() => removeEnvVar(index)}
                  className="p-3 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-xl transition-all"
                  type="button"
                  title="Delete"
                >
                  {generateIcon('delete-36-1692683695.png', 20, 'currentColor')}
                </button>
              )}
            </div>
          );
        })}

        {currentEnvVars.length === 0 && (
          <div 
            className="text-center flex flex-col relative justify-center items-center border-2 border-dashed rounded-xl transition-all"
            style={{
              borderColor: isDragging ? '#36b37e' : '#e2e8f0',
              backgroundColor: isDragging ? 'rgba(54, 179, 126, 0.05)' : '#fafafa',
              padding: '3rem 2rem',
            }}
          >
            <div className="mb-4">
              {generateIcon('key-45-1691989638.png', 56, isDragging ? '#36b37e' : 'rgba(0,0,0,0.35)')}
            </div>
            <div className="font-normal mb-2 transition-colors" style={{
              color: isDragging ? '#36b37e' : '#000',
              fontSize: '1.1rem',
            }}>
              {isDragging ? 'Drop .env file here' : 'No environment variables'}
            </div>
            <div className="text-black max-w-md text-center leading-relaxed" style={{
              fontSize: '0.95rem',
            }}>
              {isEditingMode ? (
                <>Click <span className="font-normal text-black">"Add Variable"</span> below or <span className="font-normal text-black">"Upload .env"</span> to add environment variables, or drag and drop a .env file here</>
              ) : (
                <>Click <span className="font-normal text-black">"Edit"</span> to manage environment variables</>
              )}
            </div>
          </div>
        )}

        {/* Add Variable Button - Wide placeholder style at bottom */}
        {isEditingMode && (
          <button
            onClick={addEnvVar}
            className="w-full flex items-center justify-center gap-2 py-4 border-2 border-dashed rounded-xl text-black/50 hover:text-black hover:border-gray-400 transition-all"
            style={{
              borderColor: '#e2e8f0',
              backgroundColor: '#fafafa',
            }}
          >
            {generateIcon('plus%204-49-1658433844.png', 20, 'currentColor')}
            <span className="font-normal">Add Variable</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default React.memo(EnvironmentVariables);
