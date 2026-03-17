import React, { useRef, useState } from "react";
import { Rocket, ChevronDown, ChevronUp } from "lucide-react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { EnvironmentSettings } from "./EnvironmentSettings";
import { GitInfo } from "./GitInfo";
import { projectsApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useRouter } from "next/navigation";
import BuildSettingsComponent from "@/components/import-project/BuildSettings";

export const BuildSettings = () => {
  const { buildData, updateBuild, projectData, id } = useProjectSettings();
  const router = useRouter();

  const [showEnvironment, setShowEnvironment] = useState(false);

  const [loading, setLoading] = useState({
    installCommand: false,
    buildCommand: false,
    outputDirectory: false,
    productionPaths: false,
    startCommand: false,
    productionPort: false,
    redeploy: false,
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

  const handleRedeploy = async () => {
    if (!projectData?.id) return;

    setLoading({ ...loading, redeploy: true });
    try {
      const response = await projectsApi.createDeploymentSession(projectData.id);

      if (response.success) {
        // Redirect to build page if deployment_id is returned
        if (response.deployment_id) {
          router.push(`/build/${response.deployment_id}?redeploy=true`);
        }
      } else {
        showToast(response.message || 'Failed to start redeployment', 'error', 'Error');
      }
    } catch (error) {
      console.error('Error redeploying project:', error);
      showToast('Failed to start redeployment', 'error', 'Error');
    } finally {
      setLoading({ ...loading, redeploy: false });
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-9 gap-6">
      {/* Left Column - Build Settings (6/8) */}
      <div className="lg:col-span-6 space-y-6">
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
        <div className="border-t border-gray-200 pt-6">
          <button
            onClick={() => setShowEnvironment(!showEnvironment)}
            className="w-full flex items-center justify-between p-4 bg-amber-50 hover:from-amber-100 hover:to-green-100 rounded-xl border border-amber-200/50 transition-all group"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center border border-amber-200">
                <svg className="w-5 h-5 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <div className="text-left">
                <h3 className="text-normal font-semibold text-black">Environment Variables</h3>
                <p className="text-sm text-black/60">Manage your environment variables and secrets</p>
              </div>
            </div>
            {showEnvironment ? (
              <ChevronUp className="w-5 h-5 text-amber-600 transition-transform" />
            ) : (
              <ChevronDown className="w-5 h-5 text-amber-600 transition-transform" />
            )}
          </button>

          {/* Environment Settings - Hidden by default */}
          {showEnvironment && (
            <div className="mt-6 animate-in slide-in-from-top-4 duration-300">
              <EnvironmentSettings />
            </div>
          )}
        </div>
        {/* Redeploy Section */}
        <div className="grid grid-cols-1">
          <div className="">
            <div className="mb-3">
              <h3 className="text-sm font-semibold text-black/70">Redeploy Project</h3>
              <p className="text-xs text-black/50 mt-1">Trigger a new deployment with the current configuration.</p>
            </div>

            <div className="p-4 bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl border border-indigo-200/50 mb-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-indigo-100 rounded-xl flex items-center justify-center border border-indigo-200">
                  <Rocket className="w-5 h-5 text-indigo-600" />
                </div>
                <div className="flex-1">
                  <h4 className="text-sm font-semibold text-black">Deploy Latest Changes</h4>
                  <p className="text-xs text-black/60 mt-0.5">Start a fresh deployment with your current settings</p>
                </div>
              </div>
            </div>

            <button
              onClick={handleRedeploy}
              disabled={loading.redeploy}
              className="w-full px-4 py-3 bg-indigo-600 hover:bg-indigo-700 disabled:bg-indigo-400 text-white rounded-xl transition-all text-sm font-medium disabled:cursor-not-allowed flex items-center justify-center gap-2 shadow-sm hover:shadow-md"
            >
              {loading.redeploy ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Deploying...
                </>
              ) : (
                <>
                  Redeploy Project
                </>
              )}
            </button>
          </div>
          <div />
        </div>

      </div>

      {/* Right Column - Git Info (2/8) */}
      <div className="lg:col-span-3">
        <GitInfo />
      </div>
    </div>
  );
};
