"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import ProjectSettings from "@/components/import-project/ProjectSettings";
import BuildSettings from "@/components/import-project/BuildSettings";
import DockerSettings from "@/components/import-project/DockerSettings";
import ComposeServices from "@/components/import-project/ComposeServices";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import Sidebar from "./components/Sidebar";
import DeployTargetStep, { DeployTargetSummary, useDesktopTargets } from "./components/DeployTargetStep";
import { decodeSlug } from "@/utils/repoSlug";
import { useDeployment } from "@/context/DeploymentContext";
import { useGitHub } from "@/context/GitHubContext";
import SkeletonLoader from "./components/SkeletonLoader";
import ErrorState from "@/components/shared/ErrorState";
import { PageContainer } from "@/components/ui/PageContainer";

interface DeployError {
    type: 'invalid_url' | 'repo_not_found' | 'initialization_failed';
    message: string;
    details?: string;
}

const ProjectName: React.FC = () => {
    const { config, updateConfig } = useDeployment();
    return (
        <div className="bg-card rounded-2xl border border-border/50">
            <div className="px-5 py-5">
                <label className="text-[15px] font-semibold text-foreground mb-2 block">
                    Project Name
                </label>
                <input
                    type="text"
                    value={config.projectName}
                    onChange={(e) => updateConfig({ projectName: e.target.value })}
                    placeholder="my-awesome-project"
                    className="w-full px-4 py-2.5 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
                />
                <p className="text-sm text-muted-foreground mt-1.5">
                    A unique identifier for your deployment
                </p>
            </div>
        </div>
    );
};

const DeployRepository: React.FC = () => {
    const params = useParams();
    const router = useRouter();
    const slug = params.slug as string;
    const { config, initializeFromRepo, initializeFromLocal } = useDeployment();
    const { deployMode } = useGitHub();
    const searchParams = useSearchParams();
    const force = searchParams.get("force") || undefined;
    const isDesktop = deployMode === "desktop";
    
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<DeployError | null>(null);
    const hasInitialized = useRef<boolean>(false);

    // Desktop-only: resolve available deploy targets (server / cloud)
    const targets = useDesktopTargets();

    // Step: "target" = pick build/deploy target, "config" = project settings
    // Only desktop gets step 1. Non-desktop skips straight to config.
    const [step, setStep] = useState<"target" | "config">(isDesktop ? "target" : "config");

    useEffect(() => {
        const initialize = async () => {
            if (hasInitialized.current || !slug) return;
            hasInitialized.current = true;

            const decoded = decodeSlug(slug);

            if (!decoded) {
                setError({
                    type: 'invalid_url',
                    message: 'Invalid Repository URL',
                    details: 'The repository URL format is not recognized. Please check the URL and try again.'
                });
                setLoading(false);
                return;
            }

            let result;
            if (decoded.kind === "local") {
                result = await initializeFromLocal(decoded.path);
            } else {
                result = await initializeFromRepo(decoded.owner, decoded.repo, force);
            }

            if (!result.success) {
                // If build is already in progress, redirect to build page (handled elsewhere)
                if ('buildInProgress' in result && result.buildInProgress) {
                    setLoading(false);
                    return;
                }

                // Handle specific error cases
                if (result.error) {
                    setError({
                        type: result.errorType === 'api_error' ? 'repo_not_found' : 'initialization_failed',
                        message: decoded.kind === 'local' ? 'Failed to Load Project' : 'Failed to Load Repository',
                        details: result.error
                    });
                } else {
                    setError({
                        type: 'initialization_failed',
                        message: decoded.kind === 'local' ? 'Failed to Load Project' : 'Failed to Load Repository',
                        details: decoded.kind === 'local'
                            ? 'We couldn\'t scan this folder. Make sure the path is correct and accessible.'
                            : 'We couldn\'t load this repository. It might be private, doesn\'t exist, or you don\'t have access to it.'
                    });
                }
            }
            
            setLoading(false);
        };

        initialize();
    }, [slug, initializeFromRepo, force, router]);

    if (loading) {
        return <SkeletonLoader />;
    }

    if (error) {
        return (
            <ErrorState 
                type="repo-not-found" 
                error={{
                    message: error.message,
                    details: error.details
                }}
            />
        );
    }

    if (!config.repo || !config.owner) {
        return null;
    }

    return (
        <div className="min-h-screen bg-background">
            <PageContainer>
                {/* Step 1: Deploy target picker — centered onboarding style (desktop only) */}
                {step === "target" && isDesktop && (
                    <div className="flex items-center justify-center min-h-[calc(100vh-8rem)]">
                        <div className="w-full max-w-lg">
                            <DeployTargetStep targets={targets} onContinue={() => setStep("config")} />
                        </div>
                    </div>
                )}

                {/* Step 2: Project configuration */}
                {step === "config" && (
                    <div className="grid lg:grid-cols-[1fr_340px] gap-6">
                        <div className="space-y-5">
                            {/* Target summary bar — click to go back to step 1 (desktop only) */}
                            {isDesktop && (
                                <DeployTargetSummary
                                    deployTarget={config.deployTarget}
                                    buildStrategy={config.buildStrategy}
                                    serverName={
                                      config.serverId
                                        ? (targets.servers.find((s) => s.id === config.serverId)?.name ??
                                           targets.servers.find((s) => s.id === config.serverId)?.sshHost ?? null)
                                        : null
                                    }
                                    onEdit={() => setStep("target")}
                                />
                            )}

                            {/* App flow: framework picker + build settings */}
                            {config.projectType === "app" && (
                                <>
                                    <ProjectSettings />
                                    <BuildSettings />
                                </>
                            )}

                            {/* Docker flow: single Dockerfile, just port */}
                            {config.projectType === "docker" && (
                                <DockerSettings />
                            )}

                            {/* Services flow: compose parsed services (env is per-service) */}
                            {config.projectType === "services" && (
                                <ComposeServices />
                            )}

                            {/* Global env vars — app & docker only (compose has per-service env) */}
                            {config.projectType !== "services" && (
                                <EnvironmentVariables />
                            )}
                            <ProjectName />
                        </div>
                        <Sidebar />
                    </div>
                )}
            </PageContainer>
        </div>
    );
};

export default DeployRepository;
