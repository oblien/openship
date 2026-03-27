"use client";

import React, { useEffect, useRef, useCallback, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useDeployment } from "@/context/DeploymentContext";
import DeploymentProcessing from "@/components/import-project/DeploymentProcessing";
import ComposeDeploymentProcessing from "@/components/import-project/ComposeDeploymentProcessing";
import BuildSkeleton from "@/components/import-project/BuildSkeleton";
import { useAuth } from "@/context/AuthContext";
import { Rocket, ArrowLeft, Home } from "lucide-react";

const BuildPage: React.FC = () => {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isLoggedIn } = useAuth();
  const deploymentId = params.id as string;
  const { state, config, connectToBuild, loadBuildSession, redeploy } = useDeployment();
  const hasInitialized = useRef(false);
  const [notFound, setNotFound] = useState(false);

  const loggedInRef = useRef(false);
  useEffect(() => {
    loggedInRef.current = isLoggedIn;
  }, [isLoggedIn]);
  // Initialize build session
  useEffect(() => {
    if (!deploymentId) {
      router.push("/deployments");
      return;
    }

    if (hasInitialized.current) return;
    hasInitialized.current = true;

    const initialize = async () => {
      // Coming from deploy page with fresh deployment
      if (state.deploymentId === deploymentId && state.isDeploying) {
        await connectToBuild();
        return;
      }
      const result = await loadBuildSession(deploymentId);
      if (!result.success) {
        setNotFound(true);
      }
    };

    if (!searchParams.get('redeploy')) {
      initialize();
    }

  }, [deploymentId, state.deploymentId, state.isDeploying, connectToBuild, loadBuildSession, router]);

  // Handle redeploy with URL update.
  // After router.replace the page remounts — the init effect sees
  // state.isDeploying === true and calls connectToBuild() once.
  // We must NOT call connectToBuild here too, or it fires twice.
  const handleRedeploy = useCallback(async () => {
    const newDeploymentId = await redeploy(deploymentId);

    if (newDeploymentId) {
      if (newDeploymentId !== deploymentId) {
        router.replace(`/build/${newDeploymentId}`, { scroll: false });
      } else {
        // Same ID (shouldn't happen normally) — start build directly
        await connectToBuild(newDeploymentId);
      }
    }
  }, [redeploy, deploymentId, router, connectToBuild]);

  const redeployTriggeredRef = useRef(false);

  useEffect(() => {
    if (searchParams.get('redeploy') && !redeployTriggeredRef.current) {
      redeployTriggeredRef.current = true;
      handleRedeploy();
    }
  }, [searchParams, handleRedeploy]);

  if (notFound) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-md w-full text-center">
          <div className="bg-card rounded-2xl border border-border/50 px-8 py-12">
            {/* SVG Illustration */}
            <div className="relative mx-auto w-56 h-40 mb-6">
              <svg className="absolute inset-0 w-full h-full" viewBox="0 0 224 160" fill="none">
                {/* Background broken card */}
                <rect x="52" y="30" width="120" height="90" rx="14" fill="var(--th-sf-04)" />
                <rect x="42" y="20" width="120" height="90" rx="14" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />

                {/* Card header bar */}
                <rect x="42" y="20" width="120" height="26" rx="14" fill="var(--th-sf-05)" />
                <circle cx="58" cy="33" r="3.5" fill="#ef4444" fillOpacity="0.6" />
                <circle cx="69" cy="33" r="3.5" fill="#eab308" fillOpacity="0.6" />
                <circle cx="80" cy="33" r="3.5" fill="#22c55e" fillOpacity="0.6" />

                {/* Broken content lines */}
                <rect x="56" y="56" width="40" height="4" rx="2" fill="var(--th-on-12)" />
                <rect x="56" y="66" width="70" height="3.5" rx="1.75" fill="var(--th-on-08)" />
                <rect x="56" y="75" width="25" height="3.5" rx="1.75" fill="var(--th-on-08)" />
                <rect x="88" y="75" width="30" height="3.5" rx="1.75" fill="var(--th-on-08)" />

                {/* X mark in circle */}
                <circle cx="102" cy="95" r="10" fill="var(--th-on-05)" stroke="var(--th-on-15)" strokeWidth="1" />
                <path d="M97 90l10 10M107 90l-10 10" stroke="var(--th-on-30)" strokeWidth="2" strokeLinecap="round" />

                {/* Question mark */}
                <circle cx="188" cy="60" r="20" fill="var(--th-on-05)" />
                <circle cx="188" cy="60" r="14" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="1.5" strokeDasharray="4 3" />
                <text x="188" y="66" textAnchor="middle" fill="var(--th-on-40)" fontSize="16" fontWeight="600">?</text>

                {/* Decorative dots */}
                <circle cx="20" cy="50" r="4" fill="var(--th-on-10)" />
                <circle cx="30" cy="130" r="5" fill="var(--th-on-08)" />
                <circle cx="200" cy="30" r="3" fill="var(--th-on-12)" />
                <circle cx="210" cy="120" r="4" fill="var(--th-on-06)" />

                {/* Sparkles */}
                <path d="M16 95l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
                <path d="M195 140l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />
              </svg>
            </div>

            <h2 className="text-xl font-semibold text-foreground/80 mb-2">
              Deployment not found
            </h2>
            <p className="text-sm text-muted-foreground leading-relaxed mb-8 max-w-xs mx-auto">
              This deployment doesn't exist or you don't have access to it.
              It may have been removed or the link is incorrect.
            </p>

            <div className="flex flex-col gap-3">
              <Link
                href="/deployments"
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                <Rocket className="w-4 h-4" />
                View Deployments
              </Link>
              <Link
                href="/"
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 bg-muted/50 text-foreground rounded-xl text-sm font-medium hover:bg-muted transition-colors"
              >
                <Home className="w-4 h-4" />
                Go Home
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!state.deploymentId) {
    return <BuildSkeleton />;
  }

  if (config.projectType === "services") {
    return <ComposeDeploymentProcessing onRedeploy={handleRedeploy} />;
  }

  return <DeploymentProcessing onRedeploy={handleRedeploy} />;
};

export default BuildPage;
