"use client";

import { useState } from "react";
import QRCode from "react-qr-code";
import { CheckCircle2, Copy, Loader2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { twoFactor, useSession } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Modal } from "@/components/ui/Modal";
import { SettingsSection } from "./SettingsSection";

type SecurityFlow =
  | "idle"
  | "enable-password"
  | "enrollment"
  | "regenerate-password"
  | "replacement-codes"
  | "disable-password";

function manualSecretFrom(uri: string): string | null {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "otpauth:") return null;
    return parsed.searchParams.get("secret") || null;
  } catch {
    return null;
  }
}

function resultMessage(result: { error?: { message?: string | null } | null }, fallback: string) {
  return result.error?.message || fallback;
}

export function AccountSecurity() {
  const { data: session, refetch } = useSession();
  const { t } = useI18n();
  const { showToast } = useToast();
  const copy = t.settings.security;

  const [flow, setFlow] = useState<SecurityFlow>("idle");
  const [password, setPassword] = useState("");
  const [totpURI, setTotpURI] = useState("");
  const [manualSecret, setManualSecret] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);
  const [authenticatorCode, setAuthenticatorCode] = useState("");
  const [savedCodes, setSavedCodes] = useState(false);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const enabled = session?.user.twoFactorEnabled === true;

  function clearSensitive() {
    setPassword("");
    setTotpURI("");
    setManualSecret(null);
    setBackupCodes([]);
    setAuthenticatorCode("");
    setSavedCodes(false);
    setConfirmRegenerate(false);
    setError(null);
  }

  function closeFlow() {
    if (busy) return;
    clearSensitive();
    setFlow("idle");
  }

  function openFlow(next: SecurityFlow) {
    clearSensitive();
    setFlow(next);
  }

  async function enableTwoFactor() {
    setBusy(true);
    setError(null);
    try {
      const result = await twoFactor.enable({ password });
      if (result.error) {
        setError(resultMessage(result, copy.genericError));
        return;
      }
      if (!result.data?.totpURI || result.data.backupCodes.length !== 10) {
        setError(copy.missingSetup);
        return;
      }
      setTotpURI(result.data.totpURI);
      setManualSecret(manualSecretFrom(result.data.totpURI));
      setBackupCodes(result.data.backupCodes);
      setFlow("enrollment");
    } catch {
      setError(copy.genericError);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function verifyEnrollment() {
    const submittedCode = authenticatorCode;
    setBusy(true);
    setError(null);
    try {
      const result = await twoFactor.verifyTotp({
        code: submittedCode,
        trustDevice: false,
      });
      if (result.error) {
        setError(result.error.code === "INVALID_CODE" ? copy.invalidCode : resultMessage(result, copy.genericError));
        return;
      }
      clearSensitive();
      setFlow("idle");
      await refetch();
      showToast(copy.enableSuccess, "success", copy.title);
    } catch {
      setError(copy.genericError);
    } finally {
      setAuthenticatorCode("");
      setBusy(false);
    }
  }

  async function regenerateBackupCodes() {
    setBusy(true);
    setError(null);
    try {
      const result = await twoFactor.generateBackupCodes({ password });
      if (result.error) {
        setError(resultMessage(result, copy.genericError));
        return;
      }
      if (!result.data?.backupCodes || result.data.backupCodes.length !== 10) {
        setError(copy.missingSetup);
        return;
      }
      setBackupCodes(result.data.backupCodes);
      setConfirmRegenerate(false);
      setFlow("replacement-codes");
      showToast(copy.regenerateSuccess, "success", copy.title);
    } catch {
      setError(copy.genericError);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function disableTwoFactor() {
    setBusy(true);
    setError(null);
    try {
      const result = await twoFactor.disable({ password });
      if (result.error) {
        setError(resultMessage(result, copy.genericError));
        return;
      }
      clearSensitive();
      setFlow("idle");
      await refetch();
      showToast(copy.disableSuccess, "success", copy.title);
    } catch {
      setError(copy.genericError);
    } finally {
      setPassword("");
      setBusy(false);
    }
  }

  async function copyBackupCodes() {
    try {
      await navigator.clipboard.writeText(backupCodes.join("\n"));
      showToast(copy.copied, "success", copy.title);
    } catch {
      setError(copy.genericError);
    }
  }

  const modalTitle =
    flow === "enrollment"
      ? copy.setupTitle
      : flow === "regenerate-password" || flow === "replacement-codes"
        ? copy.regenerateTitle
        : flow === "disable-password"
          ? copy.disableTitle
          : copy.passwordTitle;

  return (
    <>
      <SettingsSection
        icon={ShieldCheck}
        title={copy.title}
        description={copy.description}
        action={
          !enabled ? (
            <Button size="sm" onClick={() => openFlow("enable-password")}>
              {copy.enable}
            </Button>
          ) : undefined
        }
      >
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/60 bg-muted/20 p-4">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {copy.statusLabel}
              </p>
              <p className="mt-1 flex items-center gap-2 text-sm font-semibold text-foreground">
                {enabled && <CheckCircle2 className="size-4 text-emerald-500" />}
                {enabled ? copy.enabledStatus : copy.disabledStatus}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {enabled ? copy.enabledBody : copy.disabledBody}
              </p>
            </div>
          </div>

          {enabled && (
            <div className="flex flex-wrap gap-3">
              <Button variant="outline" onClick={() => openFlow("regenerate-password")}>
                <RefreshCw />
                {copy.regenerateAction}
              </Button>
              <Button variant="destructive" onClick={() => openFlow("disable-password")}>
                <Trash2 />
                {copy.disableAction}
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>

      <Modal
        isOpen={flow !== "idle"}
        onClose={closeFlow}
        closable={!busy}
        width="calc(100vw - 2rem)"
        maxWidth="36rem"
      >
        <div className="space-y-5 p-1 sm:p-2">
          <div className="pe-8">
            <h2 className="text-lg font-semibold text-foreground">{modalTitle}</h2>
            {flow === "enrollment" && (
              <p className="mt-1 text-sm text-muted-foreground">{copy.setupIntro}</p>
            )}
            {flow === "regenerate-password" && (
              <p className="mt-1 text-sm text-muted-foreground">{copy.regenerateWarning}</p>
            )}
            {flow === "disable-password" && (
              <p className="mt-1 text-sm text-muted-foreground">{copy.disableWarning}</p>
            )}
          </div>

          {(flow === "enable-password" ||
            flow === "regenerate-password" ||
            flow === "disable-password") && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (flow === "enable-password") void enableTwoFactor();
                else if (flow === "regenerate-password") void regenerateBackupCodes();
                else void disableTwoFactor();
              }}
            >
              <div className="space-y-2">
                <Label htmlFor="two-factor-password">{copy.passwordLabel}</Label>
                <Input
                  id="two-factor-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder={copy.passwordPlaceholder}
                  autoFocus
                />
              </div>
              {flow === "regenerate-password" && (
                <label className="flex items-start gap-2 text-sm text-foreground">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 rounded border-input"
                    checked={confirmRegenerate}
                    onChange={(event) => setConfirmRegenerate(event.target.checked)}
                  />
                  <span>{copy.confirmRegenerate}</span>
                </label>
              )}
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={closeFlow} disabled={busy}>
                  {copy.cancel}
                </Button>
                <Button
                  type="submit"
                  variant={flow === "disable-password" ? "destructive" : "default"}
                  disabled={busy || !password || (flow === "regenerate-password" && !confirmRegenerate)}
                >
                  {busy && <Loader2 className="animate-spin" />}
                  {flow === "disable-password" ? copy.disableAction : copy.continue}
                </Button>
              </div>
            </form>
          )}

          {flow === "enrollment" && (
            <div className="space-y-5">
              <div className="mx-auto w-fit max-w-full rounded-xl bg-white p-4">
                <QRCode value={totpURI} size={192} className="h-auto max-w-full" title={copy.setupTitle} />
              </div>
              {manualSecret && (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-muted-foreground">{copy.manualSecret}</p>
                  <code className="block break-all rounded-lg bg-muted px-3 py-2 text-sm text-foreground">
                    {manualSecret}
                  </code>
                </div>
              )}
              <BackupCodes codes={backupCodes} onCopy={() => void copyBackupCodes()} copy={copy} />
              <label className="flex items-start gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 rounded border-input"
                  checked={savedCodes}
                  onChange={(event) => setSavedCodes(event.target.checked)}
                />
                <span>{copy.savedCodesLabel}</span>
              </label>
              <div className="space-y-2">
                <Label htmlFor="two-factor-code">{copy.authenticatorCodeLabel}</Label>
                <Input
                  id="two-factor-code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  value={authenticatorCode}
                  onChange={(event) =>
                    setAuthenticatorCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  placeholder={copy.authenticatorCodePlaceholder}
                />
              </div>
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="ghost" onClick={closeFlow} disabled={busy}>
                  {copy.cancel}
                </Button>
                <Button
                  type="button"
                  onClick={() => void verifyEnrollment()}
                  disabled={busy || !savedCodes || authenticatorCode.length !== 6}
                >
                  {busy && <Loader2 className="animate-spin" />}
                  {busy ? copy.verifying : copy.verify}
                </Button>
              </div>
            </div>
          )}

          {flow === "replacement-codes" && (
            <div className="space-y-5">
              <BackupCodes codes={backupCodes} onCopy={() => void copyBackupCodes()} copy={copy} />
              {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
              <div className="flex justify-end">
                <Button type="button" onClick={closeFlow}>{copy.done}</Button>
              </div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

function BackupCodes({
  codes,
  onCopy,
  copy,
}: {
  codes: string[];
  onCopy: () => void;
  copy: ReturnType<typeof useI18n>["t"]["settings"]["security"];
}) {
  return (
    <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-foreground">{copy.backupCodesTitle}</h3>
        <Button type="button" size="sm" variant="outline" onClick={onCopy}>
          <Copy />
          {copy.copyAll}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">{copy.backupCodesWarning}</p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {codes.map((code) => (
          <code key={code} className="rounded-lg bg-background px-3 py-2 text-center text-sm text-foreground">
            {code}
          </code>
        ))}
      </div>
    </div>
  );
}
