import { useId, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { FeatureIllustration } from "@repo/ui/illustrations";
import { useI18n } from "@/components/i18n-provider";
import { ServerSelectorView, type ServerSelection } from "@/components/shared/ServerSelector";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";

export function DeployButton({
  review,
  projectName,
  branch,
  destinationReady,
  onDeploy,
  deploying,
  disabled,
}: {
  review?: ServerSelection;
  projectName: string;
  branch?: string;
  destinationReady: boolean;
  onDeploy: () => void;
  deploying: boolean;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const copy = t.deploy.sidebar;
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const { dialog, onKeyDown } = useDialogFocus(close, open && !!review);
  const title = useId();
  const needsChoice = review?.requiresExplicitChoice && !destinationReady;
  const shouldReview = review && (review.rows.length > 1 || needsChoice);

  return (
    <>
      <Button
        type="button"
        className="h-11 w-full"
        disabled={disabled || (!destinationReady && !shouldReview)}
        onClick={() => (shouldReview ? setOpen(true) : onDeploy())}
      >
        <Icon
          name={deploying ? "spinner" : "rocket"}
          className={deploying ? "animate-spin" : undefined}
        />
        {deploying ? copy.deploying : copy.deploy}
      </Button>
      {open && review && (
        <Modal isOpen onClose={close} width="480px" maxWidth="100%" showCloseButton={false}>
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="outline-none"
          >
            <div className="relative px-5 pt-5 sm:px-7 sm:pt-6">
              <FeatureIllustration
                name="deploy-anywhere"
                className="illustration-color mb-3 h-14 w-20"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="absolute end-4 top-4"
                onClick={close}
                aria-label={t.chrome.window.close}
              >
                <Icon name="close" />
              </Button>
              <h2 id={title} className="text-xl font-semibold tracking-tight text-foreground">
                {t.deploy.targetStep.heading}
              </h2>
              <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span className="truncate" title={projectName}>
                  {projectName}
                </span>
                {branch && (
                  <span
                    className="inline-flex min-w-0 max-w-full items-center gap-1.5"
                    title={branch}
                  >
                    <Icon name="git-branch" className="size-3.5 shrink-0" />
                    <bdi className="truncate">{branch}</bdi>
                  </span>
                )}
              </div>
            </div>
            <div className="px-5 py-6 sm:px-7">
              <ServerSelectorView
                selection={review}
                compact
                deploymentReview
                label={
                  review.connectedOnly
                    ? t.deploy.targetStep.chooseServer
                    : t.billing.workspaces.destination
                }
              />
            </div>
            <footer className="flex justify-end gap-2 border-t border-border/50 px-5 py-4 sm:px-7">
              <Button type="button" variant="ghost" onClick={close}>
                {t.projectSettings.settingSection.cancel}
              </Button>
              <Button
                type="button"
                disabled={disabled || !destinationReady}
                onClick={() => {
                  close();
                  onDeploy();
                }}
              >
                <Icon name="rocket" />
                {copy.deploy}
              </Button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
}
