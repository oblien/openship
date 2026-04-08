"use client";

import React, { createContext, useContext } from "react";
import type { DeploymentContextType } from "./deployment/types";
import { useDeploymentConfig } from "./deployment/useDeploymentConfig";
import { useDeploymentBuild } from "./deployment/useDeploymentBuild";

const DeploymentContext = createContext<DeploymentContextType | undefined>(undefined);

export const useDeployment = () => {
  const context = useContext(DeploymentContext);
  if (!context) {
    throw new Error("useDeployment must be used within DeploymentProvider");
  }
  return context;
};

export const useOptionalDeployment = () => useContext(DeploymentContext);

export const DeploymentProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const {
    config,
    setConfig,
    updateConfig,
    updateOptions,
    initializeFromRepo,
    initializeFromLocal,
  } = useDeploymentConfig();

  const {
    state,
    terminalRef,
    canStreamContainer,
    steps,
    deploymentStatus,
    startDeployment,
    connectToBuild,
    loadBuildSession,
    stopDeployment,
    redeploy,
    reset,
    onTerminalReady,
    respondToPrompt,
    _setContainerFailed,
  } = useDeploymentBuild(config, setConfig);

  const value: DeploymentContextType = {
    config,
    state,
    terminalRef,
    canStreamContainer,
    updateConfig,
    updateOptions,
    initializeFromRepo,
    initializeFromLocal,
    startDeployment,
    connectToBuild,
    loadBuildSession,
    stopDeployment,
    redeploy,
    reset,
    onTerminalReady,
    respondToPrompt,
    steps,
    deploymentStatus,
    _setContainerFailed,
  };

  return (
    <DeploymentContext.Provider value={value}>
      {children}
    </DeploymentContext.Provider>
  );
};

