"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { Modal } from "@/components/ui/Modal";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { getApiErrorMessage } from "@/lib/api/client";
import type { EmptyVolumePlan } from "./empty-volume-plan";

export type EmptyVolumeResult = { configured: boolean; started: boolean };
export function EmptyVolumeDialog({
  name,
  plan,
  onClose,
  onReset,
}: {
  name: string;
  plan: EmptyVolumePlan;
  onClose: () => void;
  onReset: (volumes: string[], configured: boolean) => Promise<EmptyVolumeResult>;
}) {
  const { t } = useI18n();
  const copy = t.projectDetail.services.detail.storage;
  const titleId = useId();
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const submit = async () => {
    if (pending.current || confirmation !== name) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await onReset(plan.volumes, configured);
      if (!alive.current) return;
      setConfigured(result.configured);
      if (result.started && result.configured) onClose();
      else setError(result.configured ? copy.emptyVolume.retryHint : copy.emptyVolume.failed);
    } catch (cause) {
      if (alive.current) setError(getApiErrorMessage(cause, copy.emptyVolume.failed));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <Modal
      isOpen
      onClose={onClose}
      closable={!busy}
      showCloseButton={false}
      maxWidth="min(540px, calc(100vw - 2rem))"
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="space-y-5 p-5 sm:p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="flex items-start gap-3">
          <span className="rounded-xl bg-warning-bg p-2.5 text-warning">
            <Icon name="hard-drive" className="size-5" />
          </span>
          <div>
            <h3 id={titleId} className="text-base font-semibold">
              {copy.emptyVolume.title}
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">{copy.emptyVolume.description}</p>
          </div>
        </div>
        <dl className="space-y-3 rounded-xl bg-muted/30 p-4 text-sm">
          {[
            [copy.serviceLabel, plan.target],
            [copy.emptyVolume.retained, plan.previous],
            [copy.emptyVolume.newVolume, plan.source],
          ].map(([label, value]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="mt-1 break-all font-mono" dir="ltr">
                {value}
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {copy.emptyVolume.recoveryHint}
        </p>
        <label className="block space-y-2 text-sm">
          <span>{interpolate(copy.emptyVolume.confirm, { name })}</span>
          <Input
            value={confirmation}
            disabled={busy}
            autoComplete="off"
            onChange={(event) => setConfirmation(event.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            {configured ? t.projectDetail.services.addModal.close : copy.cancel}
          </Button>
          <Button type="submit" disabled={busy || confirmation !== name}>
            {busy ? (
              <Icon name="spinner" className="size-4 animate-spin" />
            ) : (
              <Icon name="refresh" className="size-4" />
            )}
            {configured ? copy.emptyVolume.retry : copy.emptyVolume.action}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
