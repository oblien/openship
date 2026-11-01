"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { NotificationChannelForm } from "@/components/notifications/NotificationChannelForm";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { ChannelLogo } from "@/components/ui/ChannelLogo";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { notificationsApi, type NotificationChannel } from "@/lib/api/notifications";
import { getApiErrorMessage } from "@/lib/api/client";

export function WorkflowChannelDialog({
  channel: initial,
  onClose,
  onCreated,
  onUse,
}: {
  channel?: NotificationChannel;
  onClose: () => void;
  onCreated: (channel: NotificationChannel) => void;
  onUse: (channel: NotificationChannel) => void;
}) {
  const { t } = useI18n();
  const c = t.actions.completion;
  const [channel, setChannel] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const close = () => {
    if (!busy) onClose();
  };
  const { dialog, onKeyDown } = useDialogFocus(close);
  const test = async () => {
    if (!channel || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await notificationsApi.testChannel(channel.id);
      if (!result.ok || !result.verified) throw new Error(c.verifyFailed);
      if (active.current) onUse({ ...channel, verified: true });
    } catch (error) {
      if (active.current) setError(getApiErrorMessage(error));
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  };
  return (
    <Modal
      isOpen
      onClose={close}
      closable={!busy}
      showCloseButton={false}
      width="min(480px, 100%)"
      maxWidth="100%"
      zIndex={10001}
      surface="frosted"
    >
      <div
        ref={dialog}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-modal="true"
        aria-label={channel ? c.verifyChannelTitle : c.addChannel}
        className="space-y-4 p-5 outline-none"
      >
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-medium">{channel ? c.verifyChannelTitle : c.addChannel}</h2>
          <Button
            variant="ghost"
            size="icon"
            disabled={busy}
            onClick={close}
            aria-label={t.settings.common.close}
          >
            <Icon name="close" className="size-4" />
          </Button>
        </div>
        {!channel ? (
          <NotificationChannelForm
            onCancel={close}
            onBusyChange={setBusy}
            onCreated={onCreated}
            onSaved={(saved) => {
              // The form unmounts on this transition, so its final busy effect
              // cannot unlock the dialog's verification step.
              setBusy(false);
              if (saved.enabled && saved.verified) onUse(saved);
              else setChannel(saved);
            }}
          />
        ) : (
          <>
            <div className="flex items-center gap-3 rounded-xl bg-background p-4">
              <ChannelLogo kind={channel.kind} className="size-6 shrink-0" />
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{channel.label}</p>
                <p className="text-xs text-muted-foreground">
                  {t.settings.notifications.kinds[channel.kind]}
                </p>
              </div>
            </div>
            <p className="text-sm text-muted-foreground">{c.verifyHint}</p>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button disabled={busy || !channel.enabled} onClick={() => void test()}>
                {busy && <Icon name="spinner" className="size-4 animate-spin" />}
                {c.testAndUse}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={close}>
                {c.finishLater}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
