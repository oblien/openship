"use client";

import React from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { DeploymentsContent } from "@/app/(dashboard)/deployments/components";
import { projectsApi } from "@/lib/api";
import { servicesApi, type Service } from "@/lib/api/services";
import { useModal } from "@/context/ModalContext";
import { useToast } from "@/context/ToastContext";
import { useRouter } from "next/navigation";
import { AlertTriangle, Rocket } from "lucide-react";
import { getProjectType } from "@repo/core";
import { encodeLocalSlug, encodeRepoSlug } from "@/utils/repoSlug";

export const Deployments = () => {
  const { id, projectData, setActiveTab } = useProjectSettings();
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const router = useRouter();

  const [isRedeploying, setIsRedeploying] = React.useState(false);

  const startRedeploy = React.useCallback(async () => {
    if (!projectData?.id) return;

    const hasRepoSource = Boolean(projectData.gitOwner && projectData.gitRepo);
    const hasLocalSource = Boolean(projectData.localPath);

    if (hasRepoSource) {
      const slug = encodeRepoSlug(projectData.gitOwner, projectData.gitRepo);
      router.push(`/deploy/${slug}`);
      return;
    }

    if (hasLocalSource) {
      const slug = encodeLocalSlug(projectData.localPath);
      router.push(`/deploy/${slug}`);
      return;
    }

    showToast("Project source is missing. Reconnect the repository or local path before redeploying.", "error", "Error");
  }, [projectData?.id, router, showToast]);

  const handleRedeploy = async () => {
    if (!projectData?.id || isRedeploying) return;

    setIsRedeploying(true);
    try {
      const isServicesProject = getProjectType(projectData.framework as any) === "services";

      if (isServicesProject) {
        const serviceResponse = await servicesApi.list(projectData.id);
        const services = serviceResponse.success ? (serviceResponse.services ?? []) : [];

        if (shouldWarnAboutUnreachableServices(services)) {
          const candidateServices = services.filter(isPotentiallyPublicService);
          let modalId = "";
          modalId = showModal({
            customContent: (
              <div className="p-6 space-y-5">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 flex size-10 shrink-0 items-center justify-center rounded-2xl bg-amber-500/10 text-amber-600 dark:text-amber-400">
                    <AlertTriangle className="size-5" />
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-xl font-semibold text-foreground">No public domain is connected</h3>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      This project has {candidateServices.length} service{candidateServices.length !== 1 ? "s" : ""} with exposed ports, but none are configured with a reachable domain.
                      If you deploy now, the stack can run internally, but users will not be able to access it from a public URL.
                    </p>
                  </div>
                </div>

                <div className="rounded-2xl border border-border/60 bg-muted/30 p-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">Suggested fix</p>
                  <ul className="space-y-1.5 text-sm text-muted-foreground">
                    <li>Open the Services tab.</li>
                    <li>Pick the service that should be public.</li>
                    <li>Enable domain exposure and choose the public port.</li>
                  </ul>
                </div>

                <div className="flex items-center justify-end gap-3 pt-1">
                  <button
                    type="button"
                    className="rounded-xl border border-border bg-muted px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/80"
                    onClick={() => {
                      hideModal(modalId);
                      setActiveTab("services");
                    }}
                  >
                    Open Services
                  </button>
                  <button
                    type="button"
                    className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                    onClick={async () => {
                      hideModal(modalId);
                      await startRedeploy();
                    }}
                  >
                    Deploy Anyway
                  </button>
                </div>
              </div>
            ),
            width: "620px",
            maxWidth: "92vw",
            showCloseButton: true,
          });
          return;
        }
      }

      await startRedeploy();
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

function hasConnectedDomain(service: Service) {
  if (!service.exposed) return false;
  if (service.domainType === "custom") return Boolean(service.customDomain?.trim());
  return Boolean(service.domain?.trim());
}

function isPotentiallyPublicService(service: Service) {
  return service.enabled && (service.ports?.length ?? 0) > 0;
}

function shouldWarnAboutUnreachableServices(services: Service[]) {
  const candidateServices = services.filter(isPotentiallyPublicService);
  if (candidateServices.length === 0) return false;
  return candidateServices.every((service) => !hasConnectedDomain(service));
}
