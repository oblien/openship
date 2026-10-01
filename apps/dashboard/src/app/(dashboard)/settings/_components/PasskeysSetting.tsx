"use client";

import { useEffect, useState } from "react";
import { Icon } from "@repo/ui/icons";
import { authClient } from "@/lib/auth-client";
import { passkeysSupported } from "@/lib/account-security";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SettingsSection } from "./SettingsSection";

export function PasskeysSetting() {
  const { showToast } = useToast();
  const { t } = useI18n();
  const copy = t.settings.accountSecurity;
  const { data: items, error, isPending, refetch } = authClient.useListPasskeys();
  const [name, setName] = useState("");
  const [supported, setSupported] = useState(false);
  const [working, setWorking] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  useEffect(() => setSupported(passkeysSupported()), []);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (working) return;
    setWorking(true);
    try {
      const result = await authClient.passkey.addPasskey({
        name: name.trim() || copy.passkeyDefault,
      });
      if (result.error) throw new Error(result.error.message || copy.passkeyFailed);
      setName("");
      showToast(copy.passkeyAdded, "success", copy.passkeysTitle);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : copy.passkeyFailed,
        "error",
        copy.passkeysTitle,
      );
    } finally {
      setWorking(false);
    }
  }

  async function remove(id: string) {
    if (working) return;
    setWorking(true);
    try {
      const result = await authClient.passkey.deletePasskey({ id });
      if (result.error) throw new Error(result.error.message || copy.passkeyFailed);
      setRemoving(null);
      showToast(copy.passkeyRemoved, "success", copy.passkeysTitle);
    } catch (error) {
      showToast(
        error instanceof Error ? error.message : copy.passkeyFailed,
        "error",
        copy.passkeysTitle,
      );
    } finally {
      setWorking(false);
    }
  }

  return (
    <SettingsSection icon="key" title={copy.passkeysTitle} description={copy.passkeysDescription}>
      <div className="space-y-4">
        {supported ? (
          <form onSubmit={add} className="flex flex-col items-start gap-3 sm:flex-row sm:items-end">
            <div className="w-full min-w-0 flex-1 space-y-1.5">
              <Label htmlFor="passkey-name">{copy.passkeyName}</Label>
              <Input
                id="passkey-name"
                variant="filled"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={copy.passkeyPlaceholder}
                maxLength={80}
                disabled={working}
              />
            </div>
            <Button type="submit" disabled={working || isPending} className="shrink-0">
              {working && <Icon name="spinner" className="size-4 animate-spin" />}
              {copy.passkeyAdd}
            </Button>
          </form>
        ) : (
          <p className="text-sm text-muted-foreground">{copy.passkeyUnsupported}</p>
        )}
        {error ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 text-sm text-danger">
            <span>{error.message || copy.loadFailed}</span>
            <Button variant="secondary" size="sm" onClick={() => void refetch()}>
              {copy.retry}
            </Button>
          </div>
        ) : isPending ? (
          <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Icon name="spinner" className="size-4 animate-spin" />
            {copy.loading}
          </div>
        ) : !items?.length ? (
          <p className="text-sm text-muted-foreground">{copy.passkeysEmpty}</p>
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <li key={item.id} className="rounded-xl bg-card p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-foreground">
                      {item.name || copy.passkeyDefault}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {item.deviceType === "multiDevice" || item.backedUp
                        ? copy.synced
                        : copy.deviceBound}
                    </p>
                  </div>
                  {removing !== item.id && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={working}
                      aria-label={interpolate(copy.removeNamed, {
                        name: item.name || copy.passkeyDefault,
                      })}
                      onClick={() => setRemoving(item.id)}
                    >
                      <Icon name="trash" className="size-4" />
                    </Button>
                  )}
                </div>
                {removing === item.id && (
                  <div className="mt-3 space-y-3">
                    <p className="text-sm text-muted-foreground">{copy.removeConfirm}</p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        disabled={working}
                        onClick={() => void remove(item.id)}
                      >
                        {copy.remove}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={working}
                        onClick={() => setRemoving(null)}
                      >
                        {copy.cancel}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </SettingsSection>
  );
}
