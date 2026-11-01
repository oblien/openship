"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useId, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { api, getApiErrorMessage } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useI18n } from "@/components/i18n-provider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/Checkbox";
import { useDialogFocus } from "@/hooks/useDialogFocus";

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function UpgradeAuthModal({ open, onClose, onSuccess }: Props) {
  if (!open) return null;
  return <UpgradeAuthDialog onClose={onClose} onSuccess={onSuccess} />;
}

function UpgradeAuthDialog({ onClose, onSuccess }: Omit<Props, "open">) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (!busy) onClose();
  };
  const { dialog, onKeyDown } = useDialogFocus(close);
  return (
    <Modal isOpen onClose={close} closable={!busy} showCloseButton={false} maxWidth="28rem">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t.settings.upgradeAuth.title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="space-y-5 p-6 outline-none"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted/50">
              <Icon name="lock" className="size-5" />
            </span>
            <div>
              <h3 className="text-base font-semibold">{t.settings.upgradeAuth.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                {t.settings.upgradeAuth.description}
              </p>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={close}
            disabled={busy}
            aria-label={t.settings.upgradeAuth.close}
          >
            <Icon name="close" />
          </Button>
        </div>
        <UpgradeAuthForm onCancel={onClose} onSuccess={onSuccess} onBusyChange={setBusy} />
      </div>
    </Modal>
  );
}

/** Shared account setup. The API preserves the local user's id and credentials,
 * enables password auth atomically, and returns a signed-in session. */
export function UpgradeAuthForm({
  onCancel,
  onSuccess,
  onBusyChange,
  cancelLabel,
}: {
  onCancel: () => void;
  onSuccess: () => void;
  onBusyChange: (busy: boolean) => void;
  cancelLabel?: string;
}) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const copy = t.settings.upgradeAuth;
  const id = useId();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [useOwnMailServer, setUseOwnMailServer] = useState(false);
  const [hasMailServer, setHasMailServer] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    // Only offer the existing platform mailbox when its mail server is installed.
    type MailServer = { installedAt: string | null };
    void api
      .get<{ data: MailServer[] } | MailServer[]>("mail/servers")
      .then((res) => {
        if (!active) return;
        const installed = (Array.isArray(res) ? res : (res?.data ?? [])).some(
          (m) => m.installedAt != null,
        );
        setHasMailServer(installed);
        setUseOwnMailServer(installed);
      })
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/instance/UpgradeAuthModal");
        if (active) setHasMailServer(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    if (password.length < 8) {
      showToast(copy.toast.passwordTooShort, "error", t.settings.common.toast.authUpgrade);
      return;
    }
    setSubmitting(true);
    onBusyChange(true);
    try {
      await api.post("system/upgrade-to-auth", {
        name: name.trim(),
        email: email.trim(),
        password,
        useOwnMailServer: hasMailServer ? useOwnMailServer : false,
      });
      showToast(copy.toast.accountCreated, "success", t.settings.common.toast.authUpgrade);
      onSuccess();
    } catch (error) {
      showToast(
        getApiErrorMessage(error, copy.toast.failedUpgrade),
        "error",
        t.settings.common.toast.authUpgrade,
      );
    } finally {
      setSubmitting(false);
      onBusyChange(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor={`${id}-name`} className="block text-sm font-medium">
          {copy.name}
        </label>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoComplete="name"
          disabled={submitting}
          variant="filled"
          placeholder={copy.namePlaceholder}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-email`} className="block text-sm font-medium">
          {copy.email}
        </label>
        <Input
          id={`${id}-email`}
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          disabled={submitting}
          variant="filled"
          placeholder={copy.emailPlaceholder}
        />
      </div>
      <div className="space-y-1.5">
        <label htmlFor={`${id}-password`} className="block text-sm font-medium">
          {copy.password}
        </label>
        <div className="relative">
          <Input
            id={`${id}-password`}
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            autoComplete="new-password"
            disabled={submitting}
            variant="filled"
            className="pe-10"
            placeholder={copy.passwordPlaceholder}
          />
          <button
            type="button"
            onClick={() => setShowPassword((v) => !v)}
            disabled={submitting}
            aria-label={showPassword ? t.auth.hidePassword : t.auth.showPassword}
            aria-pressed={showPassword}
            className="absolute end-3 top-1/2 -translate-y-1/2 rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <Icon name={showPassword ? "eye-off" : "eye"} className="size-4" />
          </button>
        </div>
      </div>
      {hasMailServer && (
        <label className="flex cursor-pointer items-start gap-3 rounded-xl bg-muted/30 p-3">
          <Checkbox
            checked={useOwnMailServer}
            onCheckedChange={setUseOwnMailServer}
            disabled={submitting}
            className="mt-0.5"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2 text-sm font-medium">
              <Icon name="server" className="size-3.5 text-muted-foreground" />
              {copy.useMailServer}
            </span>
            <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
              {copy.useMailServerDesc}
            </span>
          </span>
        </label>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onCancel} disabled={submitting}>
          {cancelLabel ?? t.settings.common.cancel}
        </Button>
        <Button
          type="submit"
          disabled={submitting || !name.trim() || !email.trim() || password.length < 8}
        >
          {submitting && <Icon name="spinner" className="animate-spin" />}
          {copy.createAccount}
        </Button>
      </div>
    </form>
  );
}
