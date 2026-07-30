"use client";

import React, { useEffect, useRef, useCallback, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { useDeployment } from "@/context/DeploymentContext";
import { usesServiceDeployment } from "@/context/deployment/types";
import DeploymentProcessing from "@/components/import-project/DeploymentProcessing";
import ComposeDeploymentProcessing from "@/components/import-project/ComposeDeploymentProcessing";
import BuildSkeleton from "@/components/import-project/BuildSkeleton";
import { useAuth } from "@/context/AuthContext";
import { useI18n } from "@/components/i18n-provider";
import { ResourceNotFound } from "@/components/resource-not-found";
import { Rocket, Home, PackageX } from "lucide-react";

const BuildPage: React.FC = () => {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { isLoggedIn } = useAuth();
  const deploymentId = params.id as string;
  const { state, config, connectToBuild, loadBuildSession, redeploy, maybeOpenCredentialModal } = useDeployment();
  const { t } = useI18n();
  const initializedDeploymentRef = useRef<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  /** Ref tracking which (deploymentId × errorCode) tuple already opened
   *  the modal — prevents reopening on every re-render. */
  const shownModalRef = useRef<string | null>(null);

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

    if (initializedDeploymentRef.current === deploymentId) return;
    initializedDeploymentRef.current = deploymentId;

    const initialize = async () => {
      // Coming from deploy page with fresh deployment.
      //
      // `requestBuildAccess` on the server now calls `kickoffBuild` for us
      // (mirroring the redeploy path), so the build is already running by
      // the time we land here. We attach via GET /:id/stream
      // (`startBuild = false`) instead of POSTing /:id/build — same path as
      // the page-refresh codepath. The previous start-build round-trip was
      // racy: if the POST stalled or transiently failed (common during
      // cloud-workspace provisioning), the reconnect gate
      // (`hasConnected || !lastStartBuild`) refused to retry and the user
      // saw an empty terminal until they hit refresh. Same fix as
      // handleRedeploy below.
      if (state.deploymentId === deploymentId && state.isDeploying) {
        await connectToBuild(deploymentId, false);
        return;
      }
      const result = await loadBuildSession(deploymentId);
      if (!result.success) {
        setNotFound(true);
      }
    };

    if (!searchParams.get("redeploy")) {
      void initialize();
    }
  }, [
    deploymentId,
    state.deploymentId,
    state.isDeploying,
    connectToBuild,
    loadBuildSession,
    router,
    searchParams,
  ]);

  // Handle redeploy with URL update.
  //
  // `redeployBuildSession` on the server already calls `kickoffBuild`
  // for us (see build.service.ts:1050), so the build is running by the
  // time the response lands here. We attach via GET /:id/stream
  // (`startBuild = false`) instead of re-POSTing /:id/build, mirroring
  // the page-refresh codepath. The previous start-build round-trip was
  // racy: if the POST stalled or transiently failed, the reconnect gate
  // (`hasConnected || !lastStartBuild`) refused to retry and the user
  // saw an empty terminal until they hit refresh.
  const handleRedeploy = useCallback(async (): Promise<string | null> => {
    const newDeploymentId = await redeploy(deploymentId);

    if (newDeploymentId) {
      initializedDeploymentRef.current = newDeploymentId;
      void connectToBuild(newDeploymentId, false);
      if (newDeploymentId !== deploymentId) {
        router.replace(`/build/${newDeploymentId}`, { scroll: false });
      }
    }
    // Return the id so the Redeploy button can hold its loading state until
    // navigation (success) and only re-enable itself on failure (null).
    return newDeploymentId;
  }, [redeploy, deploymentId, router, connectToBuild]);

  const redeployTriggeredRef = useRef(false);

  useEffect(() => {
    if (searchParams.get("redeploy") && !redeployTriggeredRef.current) {
      redeployTriggeredRef.current = true;
      handleRedeploy();
    }
  }, [searchParams, handleRedeploy]);

  // ── Clone-credential recovery modal ─────────────────────────────────
  // When the build fails because no GitHub clone token could be minted
  // for the repo's owner, surface DeployCredentialModal so the user can
  // install the App / paste a PAT / switch to local build / use their
  // GitHub session instead of staring at a "Deployment Failed" toast
  // with no next step.
  useEffect(() => {
    if (!state.deploymentFailed || !state.errorCode) return;
    // De-dupe — same deployment + same code shouldn't reopen the modal on every
    // state tick. The shared handler (useDeploymentBuild.maybeOpenCredentialModal)
    // owns the modal + its options; here we just pass the build-fail trigger and
    // an auto-redeploy on the user's fix.
    const key = `${deploymentId}:${state.errorCode}`;
    if (shownModalRef.current === key) return;
    const opened = maybeOpenCredentialModal(state.errorCode, {
      trigger: "build-fail",
      onResolved: () => void handleRedeploy(),
    });
    if (opened) shownModalRef.current = key;
  }, [state.deploymentFailed, state.errorCode, deploymentId, maybeOpenCredentialModal, handleRedeploy]);

  if (notFound) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background p-6">
        <ResourceNotFound
          icon={<PackageX className="size-7" />}
          title={t.misc.buildPage.notFoundTitle}
          description={t.misc.buildPage.notFoundDescription}
          detail={deploymentId}
          detailCopyLabel={t.chrome.notFound.copyId}
          actions={[
            {
              href: "/deployments",
              label: t.misc.buildPage.viewDeployments,
              icon: <Rocket className="size-4" />,
            },
            {
              href: "/",
              label: t.misc.buildPage.goHome,
              icon: <Home className="size-4" />,
              variant: "secondary",
            },
          ]}
        />
      </div>
    );
  }

  if (!state.deploymentId) {
    return <BuildSkeleton />;
  }

  if (usesServiceDeployment(config)) {
    return <ComposeDeploymentProcessing onRedeploy={handleRedeploy} />;
  }

  return <DeploymentProcessing onRedeploy={handleRedeploy} />;
};

export default BuildPage;
