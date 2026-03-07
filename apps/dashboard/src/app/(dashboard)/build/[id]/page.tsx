"use client";

import React, { useEffect, useRef, useCallback } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useDeployment } from "@/context/DeploymentContext";
import DeploymentProcessing from "@/components/import-project/DeploymentProcessing";
import BuildSkeleton from "@/components/import-project/BuildSkeleton";
import { useAuth } from "@/context/AuthContext";

const BuildPage: React.FC = () => {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isLoggedIn } = useAuth();
  const deployment_session_id = params.id as string;
  const { state, connectToBuild, loadBuildSession, redeploy } = useDeployment();
  const hasInitialized = useRef(false);

  const loggedInRef = useRef(false);
  useEffect(() => {
    loggedInRef.current = isLoggedIn;
  }, [isLoggedIn]);
  // Initialize build session
  useEffect(() => {
    if (!deployment_session_id) {
      router.push("/deployments");
      return;
    }

    if (hasInitialized.current) return;
    hasInitialized.current = true;

    const initialize = async () => {
      // Coming from deploy page with fresh deployment
      if (state.deployment_session_id === deployment_session_id && state.buildToken) {
        await connectToBuild(); // Connect using stored token
        return;
      }
      const result = await loadBuildSession(deployment_session_id);
      if (!result.success) {
        setTimeout(() => {
          if (loggedInRef.current) {
            router.push("/deployments");
          } else {
            router.push("/");
          }
        }, 3000);
      }
    };

    if (!searchParams.get('redeploy')) {
      initialize();
    }

  }, [deployment_session_id, state.deployment_session_id, state.buildToken, connectToBuild, loadBuildSession, router]);

  // Handle redeploy with URL update
  const handleRedeploy = useCallback(async () => {
    const newSessionId = await redeploy(deployment_session_id);

    if (newSessionId) {
      if (newSessionId !== deployment_session_id) {
        // Update URL without triggering a page reload or refetch
        router.replace(`/build/${newSessionId}`, { scroll: false });
      }

      // Connect to the new build stream
      await connectToBuild();
    }
  }, [redeploy, deployment_session_id, router, connectToBuild]);

  const redeployTriggeredRef = useRef(false);

  useEffect(() => {
    if (searchParams.get('redeploy') && !redeployTriggeredRef.current) {
      handleRedeploy();
      console.log('redeployTriggeredRef.current', redeployTriggeredRef.current);
      redeployTriggeredRef.current = true;
    }
  }, [searchParams.get('redeploy'), handleRedeploy, redeployTriggeredRef]);

  if (!state.deployment_session_id) {
    return <BuildSkeleton />;
  }

  return <DeploymentProcessing onRedeploy={handleRedeploy} />;
};

export default BuildPage;
