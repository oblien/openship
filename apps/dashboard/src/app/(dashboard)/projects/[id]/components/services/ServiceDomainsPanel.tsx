"use client";

import { ProjectSettingsProvider, useOptionalProjectSettings } from "@/context/ProjectSettingsContext";
import { DomainSettings } from "../DomainSettings";
import type { ServiceDomainIntent } from "./ServicePortsCard";

export function ServiceDomainsPanel({ projectId, serviceId, intent, onChanged }: {
  projectId: string;
  serviceId: string;
  intent: ServiceDomainIntent;
  onChanged: () => void | Promise<void>;
}) {
  const project = useOptionalProjectSettings();
  const content = <DomainSettings serviceScope={{ serviceId, ...intent }} onRoutesChanged={onChanged} />;
  return project?.id === projectId ? content : (
    <ProjectSettingsProvider id={projectId}>{content}</ProjectSettingsProvider>
  );
}
