"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { ProjectMigrationCard } from "@/components/migration/ProjectMigrationCard";
import { invalidateProjectCaches } from "@/hooks/useProjectEndpoints";
import type { Service } from "@/lib/api/services";
import type { TopologyProject } from "./model";

const ServerMigrationWizard = dynamic(
  () =>
    import("@/components/migration/ServerMigrationWizard").then(
      (module) => module.ServerMigrationWizard,
    ),
  {
    loading: () => (
      <div role="status" className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        Loading migration…
      </div>
    ),
  },
);

/** An entry point into migration, not a separate placement implementation. */
export function TopologyPlacement({
  project,
  service,
  intent,
  existingRunId,
  onClose,
}: {
  project: TopologyProject;
  service?: Service;
  intent: "copy" | "move";
  existingRunId?: string;
  onClose: () => void;
}) {
  const [runId, setRunId] = useState(existingRunId);
  const close = () => {
    invalidateProjectCaches(project.id);
    onClose();
  };
  if (runId)
    return (
      <ServerMigrationWizard
        isOpen
        origin="project"
        serverId={project.serverId ?? undefined}
        initialRunId={runId}
        onClose={close}
        onBack={close}
      />
    );
  return (
    <Modal isOpen onClose={close} maxWidth="760px" width="100%">
      <div className="space-y-5 p-6">
        <div className="space-y-1.5 pe-8">
          <Button className="mb-2 -ms-2 gap-1.5" variant="ghost" size="sm" onClick={close}>
            <ArrowLeft />
            Back to topology
          </Button>
          <h2 className="text-lg font-semibold">
            {service
              ? `Clone ${service.name}`
              : intent === "copy"
                ? "Clone environment"
                : "Move environment"}
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {project.name} · {project.environmentName || project.environmentType || "Production"}
          </p>
        </div>
        <ProjectMigrationCard
          projectId={project.id}
          projectName={project.name}
          sourceServerId={project.serverId!}
          sourceServerName={project.serverName}
          initialIntent={intent}
          initialServiceNames={service ? [service.name] : undefined}
          copyOnly={!!service}
          onStarted={(id) => {
            setRunId(id);
            invalidateProjectCaches(project.id);
          }}
        />
      </div>
    </Modal>
  );
}
