"use client";

import { Icon } from "@repo/ui/icons";
import { GitHubConnection } from "@/app/(dashboard)/settings/_components/GitHubConnection";
import { GitHubSources } from "@/app/(dashboard)/settings/_components/GitHubSources";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n } from "@/components/i18n-provider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { useDialogFocus } from "@/hooks/useDialogFocus";

/** Use the existing account/App connection flow without losing the workflow draft. */
export function WorkflowGitHubConnection({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { selfHosted } = usePlatform();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  return (
    <Modal
      isOpen
      onClose={onClose}
      showCloseButton={false}
      width="min(640px, 100%)"
      maxWidth="100%"
      surface="frosted"
    >
      <div
        ref={dialog}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={t.actions.completion.githubConnection}
        className="space-y-4 p-5 outline-none"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-medium">{t.actions.completion.githubConnection}</h2>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t.settings.common.close}
          >
            <Icon name="close" className="size-4" />
          </Button>
        </div>
        <GitHubConnection />
        {selfHosted && <GitHubSources />}
        <Button variant="secondary" className="w-full" onClick={onClose}>
          {t.actions.completion.backToSetup}
        </Button>
      </div>
    </Modal>
  );
}
