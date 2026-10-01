"use client";

import { useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Icon } from "@repo/ui/icons";
import { authClient, setAccountPassword } from "@/lib/auth-client";
import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/Checkbox";
import { SettingsSection } from "./SettingsSection";

type Action = "enable" | "disable" | "regenerate" | "password";
type Step =
  | { kind: "idle" }
  | { kind: "password"; action: Action }
  | { kind: "verify"; uri: string; codes: string[] }
  | { kind: "recovery"; codes: string[] };

export function TwoFactorSetting() {
  const { t } = useI18n();
  const copy = t.settings.accountSecurity;
  const { showToast } = useToast();
  const { data: session, error: sessionError, isPending, refetch } = authClient.useSession();
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [code, setCode] = useState("");
  const [saved, setSaved] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const enabled = session?.user.twoFactorEnabled === true;

  useEffect(() => {
    if (!session?.user.id) return;
    let alive = true;
    setLoadError("");
    void authClient
      .listAccounts()
      .then((result) => {
        if (!alive) return;
        if (result.error) setLoadError(result.error.message || copy.loadFailed);
        else
          setHasPassword(
            result.data?.some((account) => account.providerId === "credential") ?? false,
          );
      })
      .catch(() => {
        if (alive) setLoadError(copy.loadFailed);
      });
    return () => {
      alive = false;
    };
  }, [session?.user.id, reload, copy.loadFailed]);

  function begin(action: Action) {
    setStep({ kind: "password", action });
    setError("");
    setPassword("");
    setConfirmation("");
    setCode("");
    setSaved(false);
  }

  function done() {
    setStep({ kind: "idle" });
    setError("");
    setPassword("");
    setConfirmation("");
    setCode("");
    setSaved(false);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (working) return;
    if (step.kind === "password" && step.action === "password" && password !== confirmation) {
      setError(copy.passwordMismatch);
      return;
    }
    setWorking(true);
    setError("");
    try {
      if (step.kind === "verify") {
        const result = await authClient.twoFactor.verifyTotp({ code: code.replace(/\s/g, "") });
        if (result.error) throw new Error(result.error.message || copy.failed);
        setStep({ kind: "recovery", codes: step.codes });
        setCode("");
        await refetch();
        showToast(copy.enabledMessage, "success", copy.title);
      } else if (step.kind === "password") {
        if (step.action === "enable") {
          const result = await authClient.twoFactor.enable({ password });
          if (result.error) throw new Error(result.error.message || copy.failed);
          setStep({ kind: "verify", uri: result.data.totpURI, codes: result.data.backupCodes });
        } else if (step.action === "regenerate") {
          const result = await authClient.twoFactor.generateBackupCodes({ password });
          if (result.error) throw new Error(result.error.message || copy.failed);
          setStep({ kind: "recovery", codes: result.data.backupCodes });
        } else if (step.action === "disable") {
          const result = await authClient.twoFactor.disable({ password });
          if (result.error) throw new Error(result.error.message || copy.failed);
          done();
          await refetch();
          showToast(copy.disabledMessage, "success", copy.title);
        } else {
          const result = await setAccountPassword(password);
          if (result.error) throw new Error(result.error.message || copy.failed);
          setHasPassword(true);
          done();
          showToast(copy.passwordAdded, "success", copy.title);
        }
        setPassword("");
        setConfirmation("");
      }
    } catch (error) {
      setError(error instanceof Error ? error.message : copy.failed);
    } finally {
      setWorking(false);
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      showToast(copy.copied, "success", copy.title);
    } catch {
      showToast(copy.copyFailed, "error", copy.title);
    }
  }

  function downloadCodes(codes: string[]) {
    const url = URL.createObjectURL(
      new Blob([codes.join("\n") + "\n"], { type: "text/plain;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "openship-recovery-codes.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const pending = isPending || hasPassword === null;
  const loadingError =
    sessionError?.message || loadError || (!isPending && !session ? copy.loadFailed : "");
  const actionLabel =
    step.kind !== "password"
      ? copy.verify
      : step.action === "enable"
        ? copy.continue
        : step.action === "disable"
          ? copy.disable
          : step.action === "regenerate"
            ? copy.regenerate
            : copy.addPassword;

  return (
    <SettingsSection icon="shield-check" title={copy.title} description={copy.description}>
      <div className="space-y-4">
        {loadingError ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
            <span>{loadingError}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                void refetch();
                setReload((value) => value + 1);
              }}
            >
              {copy.retry}
            </Button>
          </div>
        ) : pending ? (
          <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Icon name="spinner" className="size-4 animate-spin" />
            {copy.loading}
          </div>
        ) : step.kind === "idle" ? (
          <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
            <div className="min-w-0 sm:flex-1 sm:basis-64">
              <p className={`text-sm font-medium ${enabled ? "text-success" : "text-foreground"}`}>
                {enabled ? copy.enabled : copy.notEnabled}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {hasPassword ? copy.loginHint : copy.passwordNeeded}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {enabled ? (
                <>
                  <Button variant="secondary" onClick={() => begin("regenerate")}>
                    {copy.recoveryCodes}
                  </Button>
                  <Button variant="ghost" onClick={() => begin("disable")}>
                    {copy.disable}
                  </Button>
                </>
              ) : (
                <Button onClick={() => begin(hasPassword ? "enable" : "password")}>
                  {hasPassword ? copy.enable : copy.addPassword}
                </Button>
              )}
            </div>
          </div>
        ) : step.kind === "recovery" ? (
          <div className="space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-foreground">{copy.saveCodes}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{copy.codesHint}</p>
            </div>
            <div
              className="grid grid-cols-1 gap-2 rounded-xl bg-background p-4 min-[380px]:grid-cols-2"
              dir="ltr"
            >
              {step.codes.map((value) => (
                <code
                  key={value}
                  className="select-all text-center font-mono text-sm text-foreground"
                >
                  {value}
                </code>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void copyText(step.codes.join("\n"))}
              >
                <Icon name="copy" className="size-4" />
                {copy.copyCodes}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => downloadCodes(step.codes)}>
                <Icon name="download" className="size-4" />
                {copy.download}
              </Button>
            </div>
            <div className="flex items-start gap-2">
              <Checkbox
                id="saved-recovery-codes"
                checked={saved}
                onCheckedChange={setSaved}
                className="mt-0.5"
              />
              <label htmlFor="saved-recovery-codes" className="text-sm text-foreground">
                {copy.savedCodes}
              </label>
            </div>
            <Button disabled={!saved} onClick={done}>
              {copy.done}
            </Button>
          </div>
        ) : (
          <form onSubmit={submit} className="space-y-4">
            {step.kind === "password" ? (
              <>
                <p className="text-sm text-muted-foreground">
                  {step.action === "disable"
                    ? copy.disableHint
                    : step.action === "regenerate"
                      ? copy.regenerateHint
                      : step.action === "password"
                        ? copy.passwordNeeded
                        : copy.passwordHint}
                </p>
                <div className="max-w-sm space-y-1.5">
                  <Label htmlFor="security-password">
                    {step.action === "password" ? copy.newPassword : copy.password}
                  </Label>
                  <Input
                    id="security-password"
                    variant="filled"
                    type="password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete={step.action === "password" ? "new-password" : "current-password"}
                    minLength={step.action === "password" ? 8 : undefined}
                    maxLength={128}
                    required
                    autoFocus
                    disabled={working}
                  />
                </div>
                {step.action === "password" && (
                  <div className="max-w-sm space-y-1.5">
                    <Label htmlFor="security-confirm-password">{copy.confirmPassword}</Label>
                    <Input
                      id="security-confirm-password"
                      variant="filled"
                      type="password"
                      value={confirmation}
                      onChange={(event) => setConfirmation(event.target.value)}
                      autoComplete="new-password"
                      minLength={8}
                      maxLength={128}
                      required
                      disabled={working}
                    />
                  </div>
                )}
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{copy.scanHint}</p>
                <div className="flex flex-col items-start gap-4 sm:flex-row">
                  {/* QR codes need a stable high-contrast scan surface in every theme. */}
                  <QRCodeSVG
                    value={step.uri}
                    size={176}
                    marginSize={4}
                    title={copy.scanTitle}
                    className="shrink-0 rounded-xl"
                  />
                  <div className="min-w-0 flex-1 space-y-4">
                    <div className="space-y-1.5">
                      <Label htmlFor="authenticator-secret">{copy.manualKey}</Label>
                      <div className="flex gap-2">
                        <Input
                          id="authenticator-secret"
                          variant="filled"
                          value={new URL(step.uri).searchParams.get("secret") || ""}
                          readOnly
                          dir="ltr"
                          className="min-w-0 font-mono"
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          size="icon"
                          aria-label={copy.copyKey}
                          onClick={() =>
                            void copyText(new URL(step.uri).searchParams.get("secret") || "")
                          }
                        >
                          <Icon name="copy" className="size-4" />
                        </Button>
                      </div>
                    </div>
                    <div className="max-w-sm space-y-1.5">
                      <Label htmlFor="enroll-authenticator-code">{copy.code}</Label>
                      <Input
                        id="enroll-authenticator-code"
                        variant="filled"
                        value={code}
                        onChange={(event) => setCode(event.target.value)}
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={12}
                        required
                        autoFocus
                        dir="ltr"
                        disabled={working}
                      />
                    </div>
                  </div>
                </div>
              </>
            )}
            {error && (
              <p role="alert" className="rounded-xl bg-danger-bg p-3 text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                type="submit"
                disabled={working}
                variant={
                  step.kind === "password" && step.action === "disable" ? "destructive" : "default"
                }
              >
                {working && <Icon name="spinner" className="size-4 animate-spin" />}
                {actionLabel}
              </Button>
              <Button type="button" variant="secondary" disabled={working} onClick={done}>
                {copy.cancel}
              </Button>
            </div>
          </form>
        )}
      </div>
    </SettingsSection>
  );
}
