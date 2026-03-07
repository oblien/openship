"use client";

import React, { useState, useEffect, useRef } from "react";
import { useRouter, useParams, useSearchParams } from "next/navigation";
import ProjectSettings from "@/components/import-project/ProjectSettings";
import BuildSettings from "@/components/import-project/BuildSettings";
import EnvironmentVariables from "@/components/import-project/EnvironmentVariables";
import Sidebar from "./components/Sidebar";
import { decodeRepoSlug } from "@/utils/repoSlug";
import { useDeployment } from "@/context/DeploymentContext";
import SkeletonLoader from "./components/SkeletonLoader";
import ErrorState from "@/components/shared/ErrorState";
import { SectionContainer } from "@/components/ui/SectionContainer";

interface DeployError {
    type: 'invalid_url' | 'repo_not_found' | 'initialization_failed';
    message: string;
    details?: string;
}

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
        <div className="min-h-screen bg-[#fafafa]">
            <SectionContainer>
                <div className="grid lg:grid-cols-3 gap-6">
                    <div className="lg:col-span-2 space-y-6">
                        <ProjectSettings />
                        <BuildSettings />
                        <EnvironmentVariables />
                    </div>
                    <Sidebar />
                </div>
            </SectionContainer>
        </div>
    );
};

export default DeployRepository;
