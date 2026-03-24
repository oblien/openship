"use client";

import React from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { DeploymentsContent } from "@/app/(dashboard)/deployments/components";
import { projectsApi } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useRouter } from "next/navigation";
import { Rocket } from "lucide-react";

export const Deployments = () => {
  const { id, projectData } = useProjectSettings();
  const { showToast } = useToast();
  const router = useRouter();

  const [isRedeploying, setIsRedeploying] = React.useState(false);

  const handleRedeploy = async () => {
    if (!projectData?.id || isRedeploying) return;

    setIsRedeploying(true);
    try {
      const response = await projectsApi.createDeploymentSession(projectData.id);
      if (response.success && response.deployment_id) {
        router.push(`/build/${response.deployment_id}?redeploy=true`);
        return;
      }

      showToast(response.message || "Failed to start redeployment", "error", "Error");
    } catch (error) {
      console.error("Error redeploying project:", error);
      showToast("Failed to start redeployment", "error", "Error");
    } finally {
      setIsRedeploying(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="bg-card rounded-2xl border border-border/50 p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Rocket className="size-5" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">Deploy Latest Changes</h3>
              <p className="mt-1 text-sm text-muted-foreground">
                Start a fresh deployment using the current source and runtime configuration.
              </p>
            </div>
          </div>

          <button
            onClick={handleRedeploy}
            disabled={isRedeploying}
            className="inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary/50"
          >
            {isRedeploying ? "Deploying..." : "Redeploy Project"}
          </button>
        </div>
      </div>

      <DeploymentsContent projectId={id} projectName={projectData.name} hideHeader hideSidebar />
    </div>
  );
};
