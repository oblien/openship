"use client";

import React from "react";
import { useProjectSettings } from "@/context/ProjectSettingsContext";
import { DeploymentsContent } from "@/app/(dashboard)/deployments/components";

export const Deployments = () => {
  const { id, projectData } = useProjectSettings();

  return <DeploymentsContent projectId={id} projectName={projectData.name} />;
};
