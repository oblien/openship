"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useId, useRef, useState, type FormEvent } from "react";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/Modal";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { instanceApi } from "@/lib/api/instance";
import { getApiErrorMessage } from "@/lib/api/client";
import { parseInstanceAddress } from "@/lib/instance-address";

/** A Desktop connection uses the remote instance's normal authentication.
 * Keep it separate from the data-transfer dialog and its replacement consent. */
export function InstanceConnectDialog({
  onClose,
  initialAddress = "",
  onConnected,
}: {
  onClose: () => void;
  initialAddress?: string;
  onConnected?: () => void | Promise<void>;
}) {
  const { t } = useI18n();
  const copy = t.settings.instance.connection;
  const fieldId = useId();
  const [method, setMethod] = useState<"address" | "code">("address");
  const [address, setAddress] = useState(initialAddress);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const close = () => {
    if (!submitting.current) onClose();
  };
  const { dialog, onKeyDown } = useDialogFocus(close);
  const byAddress = method === "address";
  let invitationOrigin: string | null = null;
  if (byAddress) {
    try {
      const target = parseInstanceAddress(address);
      if (target?.nextPath.startsWith("/accept-invite/")) invitationOrigin = target.origin;
    } catch (diagnosticFailure) {
      observeCaughtError(diagnosticFailure, "dashboard/components/instance/InstanceConnectDialog"); /* The form shows an invalid address only after submission. */ }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (submitting.current) return;
    setError("");
    let next: ReturnType<typeof parseInstanceAddress> = null;
    if (byAddress) {
      try {
        next = parseInstanceAddress(address);
        if (!next) throw new Error(copy.invalidAddress);
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/components/instance/InstanceConnectDialog");
        setError(copy.invalidAddress);
        return;
      }
    } else if (!code.trim()) return;

    submitting.current = true;
    setBusy(true);
    try {
      if (next) {
        await instanceApi.connectAddress(next.origin);
        await onConnected?.();
        // A full navigation discards the previous instance's in-memory caches.
        // The parser permits only login or the local invitation claim screen.
        window.location.assign(next.nextPath);
      } else {
        await instanceApi.connect(code.trim());
        await onConnected?.();
        window.location.assign("/");
      }
    } catch (err) {
      setError(getApiErrorMessage(err));
      submitting.current = false;
      setBusy(false);
    }
  }

  return (
    <Modal
      isOpen
      onClose={close}
      closable={!busy}
      maxWidth="min(520px, calc(100vw - 32px))"
      maxHeight="90dvh"
      width="100%"
      overflow="hidden"
      showCloseButton={false}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${fieldId}-title`}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="max-h-[90dvh] overflow-y-auto p-5 outline-none sm:p-6"
      >
        <div className="flex items-start justify-between gap-4">
          <span className="flex size-11 items-center justify-center rounded-xl bg-muted/40 text-foreground">
            <Icon name={byAddress ? "monitor" : "key"} className="size-5" />
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t.settings.common.close}
            onClick={close}
            disabled={busy}
          >
            <Icon name="close" />
          </Button>
        </div>
        <h2 id={`${fieldId}-title`} className="mt-4 text-lg font-semibold">
          {invitationOrigin ? copy.invitationTitle : byAddress ? copy.title : copy.codeTitle}
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {invitationOrigin
            ? interpolate(copy.invitationDescription, { instance: invitationOrigin })
            : byAddress
            ? copy.description
            : interpolate(copy.codeDescription, {
                action: t.settings.instance.location.pairDesktop,
              })}
        </p>

        <form className="mt-5 space-y-4" onSubmit={(event) => void submit(event)}>
          <div className="space-y-2">
            <label htmlFor={fieldId} className="block text-sm font-medium">
              {byAddress ? copy.address : copy.codeLabel}
            </label>
            {byAddress ? (
              <Input
                id={fieldId}
                value={address}
                variant="filled"
                className="bg-muted/40 dark:bg-background dim:bg-background"
                inputMode="url"
                placeholder="https://openship.example.com"
                autoComplete="url"
                autoCapitalize="none"
                spellCheck={false}
                maxLength={2048}
                required
                disabled={busy}
                dir="ltr"
                aria-describedby={`${fieldId}-hint`}
                aria-invalid={!!error}
                onChange={(event) => {
                  setAddress(event.target.value);
                  setError("");
                }}
              />
            ) : (
              <textarea
                id={fieldId}
                value={code}
                rows={4}
                maxLength={4000}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                required
                disabled={busy}
                dir="ltr"
                aria-describedby={`${fieldId}-hint`}
                aria-invalid={!!error}
                onChange={(event) => {
                  setCode(event.target.value);
                  setError("");
                }}
                className="block w-full resize-y rounded-xl border-0 bg-muted/40 px-3.5 py-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 dark:bg-background dim:bg-background"
              />
            )}
            <p id={`${fieldId}-hint`} className="text-xs leading-relaxed text-muted-foreground">
              {invitationOrigin ? copy.invitationHint : byAddress ? copy.addressHint : copy.codeHint}
            </p>
          </div>
          {error && (
            <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            className="w-full"
            type="submit"
            disabled={busy || !(byAddress ? address.trim() : code.trim())}
          >
            <Icon
              name={busy ? "spinner" : "arrow-right"}
              className={busy ? "animate-spin" : "rtl:rotate-180"}
            />
            {busy ? copy.connecting : invitationOrigin ? copy.reviewInvitation : byAddress ? copy.continue : copy.connectCode}
          </Button>
          {!invitationOrigin && <Button
            className="h-auto w-full whitespace-normal py-2 text-xs text-muted-foreground"
            type="button"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setMethod(byAddress ? "code" : "address");
              setError("");
            }}
          >
            {byAddress ? copy.useCode : copy.useAddress}
          </Button>}
        </form>
      </div>
    </Modal>
  );
}
