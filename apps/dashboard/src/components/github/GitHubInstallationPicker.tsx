"use client";

import { useRef, useState } from "react";
import { Icon } from "@repo/ui/icons";
import type { GitHubInstallationSelection } from "@repo/contracts";
import { githubApi, getApiErrorMessage } from "@/lib/api";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";

type PickerProps = {
  selection: GitHubInstallationSelection;
  onComplete: () => void;
  onInstall: () => void;
  onRestart: () => void;
  onBusyChange?: (busy: boolean) => void;
};

export function GitHubInstallationDialog(
  props: Omit<PickerProps, "onBusyChange"> & { onClose: () => void },
) {
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (!busy) props.onClose();
  };
  return (
    <Modal
      isOpen
      onClose={close}
      closable={!busy}
      showCloseButton={false}
      width="min(480px, 100%)"
      maxWidth="100%"
    >
      <InstallationDialogContent {...props} onClose={close} busy={busy} onBusyChange={setBusy} />
    </Modal>
  );
}

function InstallationDialogContent(props: PickerProps & { onClose: () => void; busy: boolean }) {
  const { t } = useI18n();
  const { dialog, onKeyDown } = useDialogFocus(props.onClose);
  return (
    <div
      ref={dialog}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="space-y-4 p-6 outline-none"
      role="dialog"
      aria-modal="true"
      aria-label={t.library.connect.installationPicker.title}
    >
      <GitHubInstallationPicker
        {...props}
        onBusyChange={(busy) => {
          // Disabling the clicked button can move browser focus to the page.
          // Keep it in the dialog so error recovery and Escape still work.
          if (busy) dialog.current?.focus();
          props.onBusyChange?.(busy);
        }}
      />
      <Button variant="ghost" className="w-full" onClick={props.onClose} disabled={props.busy}>
        {t.settings.common.cancel}
      </Button>
    </div>
  );
}

/** Shared by the dashboard dialog and OAuth callback window. */
export function GitHubInstallationPicker({
  selection,
  onComplete,
  onInstall,
  onRestart,
  onBusyChange,
}: PickerProps) {
  const { t } = useI18n();
  const copy = t.library.connect.installationPicker;
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const connect = async (id: number) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(id);
    setError(null);
    onBusyChange?.(true);
    try {
      const result = await githubApi.claimInstallation({
        state: selection.state,
        installationId: String(id),
      });
      if (!result.ok || !result.installation || result.pendingApproval)
        throw new Error(copy.failed);
      onComplete();
    } catch (error) {
      setError(getApiErrorMessage(error, copy.failed));
    } finally {
      inFlight.current = false;
      setPending(null);
      onBusyChange?.(false);
    }
  };

  return (
    <div className="space-y-5" aria-busy={pending !== null}>
      <div className="space-y-1.5">
        <h2 className="text-xl font-semibold text-foreground">{copy.title}</h2>
        <p className="text-sm text-muted-foreground">{copy.description}</p>
      </div>
      <div className="max-h-80 space-y-2 overflow-y-auto">
        {selection.installations.map((installation) => (
          <button
            key={installation.id}
            type="button"
            disabled={pending !== null}
            onClick={() => void connect(installation.id)}
            className="flex w-full items-center gap-3 rounded-xl bg-muted/40 p-3.5 text-start transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
          >
            <InstallationAvatar avatarUrl={installation.avatarUrl} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {installation.login}
              </span>
              <span className="block text-xs text-muted-foreground">
                {installation.connected ? copy.connected : copy.connect}
              </span>
            </span>
            <Icon
              name={pending === installation.id ? "spinner" : "arrow-right"}
              className={`size-4 shrink-0 text-muted-foreground ${pending === installation.id ? "animate-spin" : "rtl:rotate-180"}`}
            />
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{copy.sharedHint}</p>
      {error && (
        <div role="alert" className="space-y-2 rounded-xl bg-danger-bg p-3 text-sm text-danger">
          <p>{error}</p>
          <Button variant="ghost" size="sm" onClick={onRestart} disabled={pending !== null}>
            {copy.tryAgain}
          </Button>
        </div>
      )}
      <Button
        variant="secondary"
        onClick={onInstall}
        disabled={pending !== null}
        className="w-full"
      >
        <Icon name="plus" className="size-4" />
        {copy.installAnother}
      </Button>
    </div>
  );
}

function InstallationAvatar({ avatarUrl }: { avatarUrl: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <span className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-card">
      {avatarUrl && failedUrl !== avatarUrl ? (
        <img
          src={avatarUrl}
          alt=""
          className="size-full object-cover"
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailedUrl(avatarUrl)}
        />
      ) : (
        <Icon name="github" className="size-5 text-foreground" aria-hidden="true" />
      )}
    </span>
  );
}
