"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/components/i18n-provider";
import { ProjectEnvironmentPanel } from "@/components/project-settings/ProjectEnvironmentPanel";

/** Settings opens the same project environment panel as Apps & Services. */
export function EnvVarsEditor({
  projectId,
  isOpen,
  onClose,
}: {
  projectId: string;
  isOpen: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      closable={!busy}
      showCloseButton={false}
      maxWidth="960px"
      width="94vw"
      footer={
        <div className="flex justify-end border-t border-border/50 px-5 py-3">
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t.projectSettings.envVars.close}
          </Button>
        </div>
      }
    >
      {isOpen && <ProjectEnvironmentPanel key={projectId} onBusyChange={setBusy} />}
    </Modal>
  );
}
