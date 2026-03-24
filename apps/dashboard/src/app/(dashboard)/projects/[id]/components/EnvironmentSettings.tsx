"use client";
import React, { useMemo, useState, useEffect, useRef } from "react";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { useToast } from "@/context/ToastContext";
import { projectsApi } from "@/lib/api";
import generateIcon from "@/utils/icons";

export const EnvironmentSettings: React.FC = () => {
  const { environmentData, updateEnvironment, refreshEnvironment, id } = useProjectSettings();
  const { showToast } = useToast();
  // Convert environmentData.envVars format to EnvironmentVariables format
  const savedEnvVars = useMemo(() => {
    const allEnvs: Array<{ key: string; value: string; visible: boolean }> = [];

    // Combine all environments into a single list
    Object.entries(environmentData.envVars || {}).forEach(([env, vars]) => {
      if (Array.isArray(vars)) {
        vars.forEach((envVar: any) => {
          allEnvs.push({
            key: envVar.key,
            value: envVar.value,
            visible: false,
          });
        });
      }
    });

    return allEnvs;
  }, [environmentData.envVars]);

  const [localEnvVars, setLocalEnvVars] = useState(savedEnvVars);
  const [hasChanges, setHasChanges] = useState(false);
  const [isEditingMode, setIsEditingMode] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const localEnvVarsRef = useRef(localEnvVars);

  useEffect(() => {
    localEnvVarsRef.current = localEnvVars;
  }, [localEnvVars]);

  // Fetch environment variables when component mounts if not already loaded
  useEffect(() => {
    const shouldFetch =
      !environmentData.isLoading &&
      !environmentData.error &&
      (!environmentData.envVars || Object.keys(environmentData.envVars).length === 0);

    if (shouldFetch) {
      refreshEnvironment();
    }
  }, []);

  // Update local state when environment data changes
  useEffect(() => {
    if (!environmentData.isLoading && savedEnvVars.length > 0) {
      setLocalEnvVars(savedEnvVars);
    }
  }, [savedEnvVars]);

  const handleEnvVarsChange = (
    value:
      | Array<{ key: string; value: string; visible: boolean }>
      | ((
        prev: Array<{ key: string; value: string; visible: boolean }>
      ) => Array<{ key: string; value: string; visible: boolean }>)
  ) => {
    const newEnvVars = typeof value === "function" ? value(localEnvVars) : value;
    setLocalEnvVars(newEnvVars);
    setHasChanges(true);
  };

  const handleSave = async () => {
    // Filter out completely empty entries (both key and value empty)
    const filteredEnvVars = localEnvVarsRef.current.filter(env =>
      env.key.trim() !== '' || env.value.trim() !== ''
    );

    // Validate: check if any entry has key without value or value without key
    const invalidEntry = filteredEnvVars.find(env =>
      (env.key.trim() !== '' && env.value.trim() === '') ||
      (env.key.trim() === '' && env.value.trim() !== '')
    );

    if (invalidEntry) {
      if (invalidEntry.key.trim() !== '' && invalidEntry.value.trim() === '') {
        showToast(`Environment variable "${invalidEntry.key}" is missing a value`, 'error', 'Validation Error');
      } else {
        showToast('Environment variable has a value but is missing a key name', 'error', 'Validation Error');
      }
      return;
    }

    // Prepare data for API
    const envData = filteredEnvVars.map(env => ({
      key: env.key.trim(),
      value: env.value.trim(),
    }));

    setIsSaving(true);

    try {
      // Make API request to save environment variables
      const response = await projectsApi.setEnv(id, envData);

      if (response.success) {
        showToast('Environment variables saved successfully', 'success', 'Saved');

        // Update local state with cleaned data
        const cleanedEnvVars = filteredEnvVars.map(env => ({
          key: env.key.trim(),
          value: env.value.trim(),
          visible: env.visible,
        }));

        setLocalEnvVars(cleanedEnvVars);

        // Update context
        const envVars = {
          development: cleanedEnvVars.map((env, index) => ({
            id: Date.now() + index,
            key: env.key,
            value: env.value,
            encrypted: true,
          })),
          preview: [],
          production: [],
        };

        updateEnvironment(envVars);
        setHasChanges(false);
        setIsEditingMode(false);

      } else {
        showToast(response.message || 'Failed to save environment variables', 'error', 'Save Failed');
      }
    } catch (error) {
      console.error('Error saving environment variables:', error);
      showToast('An error occurred while saving. Please try again.', 'error', 'Error');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setLocalEnvVars(savedEnvVars);
    setHasChanges(false);
    setIsEditingMode(false);
  };

  // Show loading state with skeleton
  if (environmentData.isLoading) {
    return (
      <div className="space-y-4">
        {/* Security Notice Skeleton */}
        <div className="bg-gradient-to-r from-muted to-muted/40 border border-border rounded-xl p-4 flex items-start gap-3 animate-pulse">
          <div className="h-5 w-5 bg-muted-foreground/20 rounded-full mt-0.5 flex-shrink-0"></div>
          <div className="flex-1 space-y-2">
            <div className="h-4 bg-muted-foreground/20 rounded-full w-40"></div>
            <div className="h-3 bg-muted/70 rounded-full w-full"></div>
            <div className="h-3 bg-muted/70 rounded-full w-3/4"></div>
          </div>
        </div>

        {/* Environment Variables Container Skeleton */}
        <div className="bg-card border border-border rounded-xl p-6 space-y-4">
          {/* Header Skeleton */}
          <div className="flex items-center justify-between pb-4 border-b border-border">
            <div className="h-6 bg-muted-foreground/20 rounded-full w-48 animate-pulse"></div>
            <div className="h-10 bg-muted-foreground/20 rounded-full w-32 animate-pulse"></div>
          </div>

          {/* Environment Variable Items Skeleton */}
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 p-4 bg-muted/40 rounded-lg animate-pulse">
              <div className="flex-1 space-y-2">
                <div className="h-4 bg-muted-foreground/20 rounded-full w-32"></div>
                <div className="h-3 bg-muted/70 rounded-full w-48"></div>
              </div>
              <div className="flex gap-2">
                <div className="h-8 w-8 bg-muted-foreground/20 rounded-full"></div>
                <div className="h-8 w-8 bg-muted-foreground/20 rounded-full"></div>
              </div>
            </div>
          ))}

          {/* Add Button Skeleton */}
          <div className="flex justify-center pt-4">
            <div className="h-10 bg-muted-foreground/20 rounded-full w-48 animate-pulse"></div>
          </div>
        </div>
      </div>
    );
  }

  // Show error state
  if (environmentData.error) {
    return (
      <div className="space-y-4">
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3">
          <div className="flex-1">
            <h4 className="font-semibold text-red-700 dark:text-red-300 mb-1">Error Loading Environment</h4>
            <p className="text-sm text-red-700/80 dark:text-red-300/80">{environmentData.error}</p>
            <button
              onClick={refreshEnvironment}
              className="mt-3 px-4 py-2 bg-destructive text-destructive-foreground rounded-lg hover:opacity-90 transition-opacity"
            >
              Retry
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" style={{ opacity: isSaving ? 0.5 : 1, transition: 'opacity 0.3s', pointerEvents: isSaving ? 'none' : 'auto' }}>
      {/* Security Notice */}
      <div className="bg-gradient-to-r from-emerald-500/10 to-green-500/10 border relative border-emerald-500/20 rounded-xl p-4 flex items-start gap-3">
        <div className="w-10 h-10 bg-emerald-500/10 rounded-xl absolute flex items-center justify-center border border-emerald-500/20">
          {generateIcon('shield-123-1691989638.png', 24, 'hsl(var(--primary))')}
        </div>
        <div className="ml-14">
          <h4 className="font-semibold text-emerald-700 dark:text-emerald-300 mb-1">Secure & Encrypted</h4>
          <p className="text-sm text-emerald-700/80 dark:text-emerald-300/80">
            All environment variables are stored with end-to-end encryption. We don't have access to your environment variables, and no third party can access them.
          </p>
        </div>
      </div>

      {/* Environment Variables Component */}
      <EnvironmentVariables
        mode="settings"
        envVars={localEnvVars}
        onEnvVarsChange={handleEnvVarsChange}
        isEditingMode={isEditingMode}
        setIsEditingMode={setIsEditingMode}
        onSave={handleSave}
        onCancel={handleCancel}
        hasChanges={hasChanges}
        isSaving={isSaving}
      />
    </div>
  );
};
