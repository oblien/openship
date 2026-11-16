"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import dynamic from "next/dynamic";
import { useId, useState } from "react";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";
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
        <UiIcon name="spinner" className="size-4 animate-spin" />
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
  const titleId = useId();
  const close = () => {
    invalidateProjectCaches(project.id);
    onClose();
  };
  const { dialog, onKeyDown } = useDialogFocus(close, !runId);
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
    <Modal isOpen onClose={close} maxWidth="1040px" width="100%">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="space-y-6 p-5 outline-none sm:p-8"
      >
        <div className="flex items-center gap-4 pe-8">
          <FeatureIllustration
            name="instance-transfer"
            className="illustration-color h-16 w-20 shrink-0"
          />
          <div className="min-w-0 space-y-1.5">
            <h2 id={titleId} className="text-2xl font-medium">
              {service
                ? `Duplicate ${service.name}`
                : intent === "copy"
                  ? "Duplicate environment"
                  : "Move environment"}
            </h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              {project.name} · {project.environmentName || project.environmentType || "Production"}
            </p>
          </div>
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
