import React, { useRef, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { projectsApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import BuildSettingsComponent from "@/components/import-project/BuildSettings";

export const BuildSettings = () => {
  const { buildData, updateBuild, projectData, id } = useProjectSettings();

  const [showEnvironment, setShowEnvironment] = useState(false);

  const [loading, setLoading] = useState({
    installCommand: false,
    buildCommand: false,
    outputDirectory: false,
    productionPaths: false,
    startCommand: false,
    productionPort: false,
  });

  const { showToast } = useToast();

  const isLoadingRef = useRef(false);

  const handleSaveField = async (field: string, value: string) => {
    if (isLoadingRef.current) return;

    setLoading({ ...loading, [field]: true });
    isLoadingRef.current = true;

    const response = await projectsApi.setOptions(id, { [field]: value });

    if (response.success) {
      updateBuild({ [field]: value });
      showToast('Project options updated successfully', 'success', 'Updated');
    } else {
      showToast(response.message, 'error', 'Failed to update project options');
    }

    isLoadingRef.current = false;
    setLoading({ ...loading, [field]: false });
  };

  return (
    <div className="max-w-5xl space-y-6">
        <BuildSettingsComponent
          mode="advanced"
          buildData={buildData}
          buildConfig={{
            options: buildData,
            updateOptions: updateBuild,
            framework: projectData?.framework,
          }}
          onSave={handleSaveField}
          loading={loading}
        />

        {/* <ServerSideSwitch
          style={{ background: '#fafafa' }}
          productionPort={buildData.productionPort}
          hasServer={buildData.hasServer}
          handleServerToggleChange={(checked: boolean) => updateBuild({ hasServer: checked })}
        /> */}
        {/* Environment Settings Toggle Button */}
        <div className="border-t border-border pt-6">
          <button
            onClick={() => setShowEnvironment(!showEnvironment)}
            className="w-full flex items-center justify-between p-4 bg-amber-500/10 rounded-xl border border-amber-500/20 transition-all group"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-500/15 rounded-xl flex items-center justify-center border border-amber-500/20">
                <svg className="w-5 h-5 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <div className="text-left">
                <h3 className="text-normal font-semibold text-foreground">Environment Variables</h3>
                <p className="text-sm text-muted-foreground">Manage your environment variables and secrets</p>
              </div>
            </div>
            {showEnvironment ? (
              <ChevronUp className="w-5 h-5 text-amber-600 dark:text-amber-400 transition-transform" />
            ) : (
              <ChevronDown className="w-5 h-5 text-amber-600 dark:text-amber-400 transition-transform" />
            )}
          </button>

          {/* Environment Settings - Hidden by default */}
          {showEnvironment && (
            <div className="mt-6 animate-in slide-in-from-top-4 duration-300">
              <EnvironmentSettings />
            </div>
          )}
        </div>
    </div>
  );
};
