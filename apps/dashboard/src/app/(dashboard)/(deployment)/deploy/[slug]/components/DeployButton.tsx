import { useId, useState } from "react";
import type { ServerDetail } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { ManagedServerStatus } from "@/components/servers/managed/ManagedServerStatus";
import { ServerRowContent } from "@/components/shared/ServerPicker";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";

export interface DestinationReview {
  server: ServerDetail;
  onChange: () => void;
}

export function DeployButton({ review, onDeploy, deploying, disabled }: {
  review?: DestinationReview;
  onDeploy: () => void;
  deploying: boolean;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const copy = t.deploy.sidebar;
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const { dialog, onKeyDown } = useDialogFocus(close, open);
  const title = useId();
  const hint = useId();

  return (
    <>
      <Button
        type="button"
        className="h-11 w-full"
        disabled={disabled}
        onClick={() => review ? setOpen(true) : onDeploy()}
      >
        <Icon name={deploying ? "spinner" : "rocket"} className={deploying ? "animate-spin" : undefined} />
        {deploying ? copy.deploying : copy.deploy}
      </Button>
      {open && review && (
        <Modal isOpen onClose={close} width="440px" maxWidth="100%" showCloseButton={false}>
          <div
            ref={dialog}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title}
            aria-describedby={hint}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            className="space-y-5 p-6 outline-none"
          >
            <div className="flex items-start justify-between gap-3">
              <h2 id={title} className="text-lg font-semibold text-foreground">{copy.confirmDestination}</h2>
              <Button variant="ghost" size="icon" className="-me-2 -mt-2" onClick={close} aria-label={t.chrome.window.close}>
                <Icon name="close" />
              </Button>
            </div>
            <div className="flex items-center gap-3 rounded-xl bg-muted/40 p-3">
              <ServerRowContent server={review.server} details="plan" />
              {review.server.managed && <ManagedServerStatus workspace={review.server.managed} />}
            </div>
            <p id={hint} className="text-sm leading-relaxed text-muted-foreground">{copy.destinationReviewHint}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onClick={() => { close(); review.onChange(); }}>{copy.changeDestination}</Button>
              <Button disabled={disabled} onClick={() => { close(); onDeploy(); }}>{copy.deploy}</Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
