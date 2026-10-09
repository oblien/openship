"use client";

import { useId, useState } from "react";
import type { ServerOperations } from "@repo/contracts";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { systemApi } from "@/lib/api/system";
import { ManagedControlPanel, ConnectionValue } from "./ManagedControlPanel";
import { useManagedServerResource, useManagedServerSecret } from "./useManagedServerResource";

type TemporaryConnection = Awaited<ReturnType<ServerOperations["managedSshConnection"]>>;

export function ManagedServerSsh({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const common = t.servers.managedControls;
  const copy = common.ssh;
  const resource = useManagedServerResource(serverId, systemApi.managedSshStatus);
  const secret = useManagedServerSecret<{
    initialPassword?: string;
    connection?: TemporaryConnection;
  }>(serverId);
  const [publicKey, setPublicKey] = useState("");
  const [password, setPassword] = useState("");
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const keyId = useId(),
    passwordId = useId();
  const status = resource.data;
  const enabled = status?.enabled === true;

  function toggle(next: boolean) {
    if (status?.enabled == null) return;
    secret.clear();
    setNotice(null);
    void resource.run(
      () =>
        systemApi.setManagedSsh(serverId, {
          enabled: next,
          expectedEnabled: status.enabled!,
          confirm: true,
        }),
      (result) => {
        resource.replace(result.status);
        setConfirmDisable(false);
        setNotice(common.saved);
        if (result.initialPassword) secret.reveal({ initialPassword: result.initialPassword });
      },
    );
  }
  return (
    <ManagedControlPanel title={copy.title} description={copy.description} icon="key" {...resource}>
      {status ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/30 p-4">
            <p className="text-sm font-medium">
              {status.enabled == null
                ? common.unavailable
                : enabled
                  ? common.enabled
                  : common.disabled}
            </p>
            {status.enabled != null && (
              <Button
                variant={enabled ? "secondary" : "default"}
                disabled={resource.busy}
                onClick={() => (enabled ? setConfirmDisable(true) : toggle(true))}
              >
                {enabled ? copy.disable : copy.enable}
              </Button>
            )}
          </div>
          {confirmDisable && (
            <div className="space-y-3 rounded-xl bg-warning/10 p-4">
              <p className="text-sm">{copy.disableHint}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="destructive"
                  disabled={resource.busy}
                  onClick={() => toggle(false)}
                >
                  {copy.confirmDisable}
                </Button>
                <Button
                  variant="ghost"
                  disabled={resource.busy}
                  onClick={() => setConfirmDisable(false)}
                >
                  {common.cancel}
                </Button>
              </div>
            </div>
          )}
          {notice && (
            <p role="status" className="text-sm text-success">
              {notice}
            </p>
          )}
          {enabled && (
            <>
              {status.connection && (
                <ConnectionValue label={copy.command} value={status.connection.command} />
              )}
              {status.requiresIdentityAccess && (
                <p className="text-sm text-muted-foreground">{copy.identityHint}</p>
              )}
              <div className="space-y-3">
                <Button
                  variant="secondary"
                  disabled={resource.busy}
                  onClick={() => {
                    secret.clear();
                    setNotice(null);
                    void resource.run(
                      () => systemApi.managedSshConnection(serverId, { confirm: true }),
                      (connection) => secret.reveal({ connection }),
                    );
                  }}
                >
                  {copy.temporary}
                </Button>
                <p className="text-xs text-muted-foreground">{copy.temporaryHint}</p>
              </div>
            </>
          )}
          {secret.value && (
            <div className="space-y-4 rounded-xl bg-muted/30 p-4">
              <p className="text-sm text-muted-foreground">{common.secretHint}</p>
              {secret.value.initialPassword && (
                <ConnectionValue
                  label={copy.initialPassword}
                  value={secret.value.initialPassword}
                  secret
                />
              )}
              {secret.value.connection && (
                <>
                  <ConnectionValue
                    label={copy.command}
                    value={`ssh -p ${secret.value.connection.port} ${secret.value.connection.username}@${secret.value.connection.host}`}
                  />
                  <ConnectionValue
                    label={copy.password}
                    value={secret.value.connection.password}
                    secret
                  />
                  <ConnectionValue
                    label={copy.fingerprint}
                    value={secret.value.connection.hostKeyFingerprint}
                  />
                  <p className="text-xs text-muted-foreground">
                    {common.expires}: {new Date(secret.value.connection.expiresAt).toLocaleString()}
                  </p>
                </>
              )}
              <Button variant="ghost" onClick={secret.clear}>
                {common.hideSecrets}
              </Button>
            </div>
          )}
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              setNotice(null);
              void resource.run(
                () => systemApi.setManagedSshKey(serverId, { publicKey, confirm: true }),
                (result) => {
                  resource.replace(result);
                  setPublicKey("");
                  setNotice(copy.keySaved);
                },
              );
            }}
          >
            <label className="block text-sm font-medium" htmlFor={keyId}>
              {copy.publicKey}
            </label>
            <p className="text-xs text-muted-foreground">{copy.keyHint}</p>
            <Textarea
              id={keyId}
              variant="filled"
              className="bg-muted/40 font-mono text-xs"
              dir="ltr"
              rows={3}
              value={publicKey}
              onChange={(event) => setPublicKey(event.target.value)}
              maxLength={16384}
              placeholder="ssh-ed25519 AAAA…"
              required
              disabled={resource.busy || !enabled}
            />
            <p className="text-xs text-muted-foreground">
              {status.keyConfigured ? copy.keyConfigured : copy.keyMissing}
            </p>
            <Button
              type="submit"
              variant="secondary"
              disabled={resource.busy || !enabled || !publicKey.trim()}
            >
              {copy.saveKey}
            </Button>
          </form>
          <details className="rounded-xl bg-muted/20 p-4">
            <summary className="cursor-pointer text-sm font-medium">{copy.passwordTitle}</summary>
            <form
              className="mt-4 space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                setNotice(null);
                const value = password;
                setPassword("");
                secret.clear();
                void resource.run(
                  () =>
                    systemApi.setManagedSshPassword(serverId, { password: value, confirm: true }),
                  (result) => {
                    resource.replace(result);
                    setNotice(copy.passwordSaved);
                  },
                );
              }}
            >
              <p className="text-xs text-muted-foreground">{copy.passwordHint}</p>
              <label className="block text-sm" htmlFor={passwordId}>
                {copy.password}
              </label>
              <Input
                id={passwordId}
                variant="filled"
                type="password"
                autoComplete="new-password"
                value={password}
                minLength={12}
                maxLength={128}
                required
                onChange={(event) => setPassword(event.target.value)}
                disabled={resource.busy || !enabled}
              />
              <Button
                type="submit"
                variant="secondary"
                disabled={resource.busy || !enabled || password.length < 12}
              >
                {copy.savePassword}
              </Button>
            </form>
          </details>
        </>
      ) : (
        resource.busy && <div className="h-32 animate-pulse rounded-xl bg-muted/40" />
      )}
    </ManagedControlPanel>
  );
}
