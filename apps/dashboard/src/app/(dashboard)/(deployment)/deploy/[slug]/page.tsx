"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import ProjectSettings from "@/components/import-project/ProjectSettings";
import BuildSettings from "@/components/import-project/BuildSettings";
import DockerSettings from "@/components/import-project/DockerSettings";
import ComposeServices from "@/components/import-project/ComposeServices";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import Sidebar from "./components/Sidebar";
import { decodeRepoSlug } from "@/utils/repoSlug";
import { useDeployment } from "@/context/DeploymentContext";
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
    const { config, initializeFromRepo } = useDeployment();
    const searchParams = useSearchParams();
    const force = searchParams.get("force") || undefined;
    
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<DeployError | null>(null);
    const hasInitialized = useRef<boolean>(false);

    useEffect(() => {
        const initialize = async () => {
            if (hasInitialized.current || !slug) return;
            hasInitialized.current = true;

            const decoded = decodeRepoSlug(slug);

            if (!decoded) {
                setError({
                    type: 'invalid_url',
                    message: 'Invalid Repository URL',
                    details: 'The repository URL format is not recognized. Please check the URL and try again.'
                });
                setLoading(false);
                return;
            }

            const { owner, repo } = decoded;
            const result = await initializeFromRepo(owner, repo, force);

            if (!result.success) {
                // If build is already in progress, redirect to build page (handled elsewhere)
                if (result.buildInProgress) {
                    // Build in progress handling - typically redirected by parent component
                    setLoading(false);
                    return;
                }

                // Handle specific error cases
                if (result.error) {
                    setError({
                        type: result.errorType === 'api_error' ? 'repo_not_found' : 'initialization_failed',
                        message: 'Failed to Load Repository',
                        details: result.error
                    });
                } else {
                    // Generic fallback error
                    setError({
                        type: 'initialization_failed',
                        message: 'Failed to Load Repository',
                        details: 'We couldn\'t load this repository. It might be private, doesn\'t exist, or you don\'t have access to it.'
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
                <div className="grid lg:grid-cols-[1fr_340px] gap-6">
                    <div className="space-y-5">
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
            </PageContainer>
        </div>
    );
};

export default DeployRepository;
