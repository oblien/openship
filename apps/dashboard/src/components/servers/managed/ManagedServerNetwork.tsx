"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ServerOperations } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { systemApi } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";

type NetworkSettings = Awaited<ReturnType<ServerOperations["getNetworkSettings"]>>;

export function ManagedServerNetwork({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const copy = t.billing.workspaces.network;
  const checkboxId = useId();
  const [settings, setSettings] = useState<NetworkSettings | null>(null);
  const [internet, setInternet] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    let current = true;
    setBusy(true);
    setError(null);
    void systemApi
      .getServerNetworkSettings(serverId)
      .then((result) => {
        if (!current) return;
        setSettings(result);
        setInternet(result.internetAccess ?? false);
      })
      .catch((error) => {
        if (current) setError(getApiErrorMessage(error));
      })
      .finally(() => {
        if (current) setBusy(false);
      });
    return () => {
      current = false;
    };
  }, [serverId, attempt]);
  async function save() {
    if (inFlight.current || busy || settings?.internetAccess == null) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await systemApi.updateServerNetworkSettings(serverId, {
        internetAccess: internet,
        expectedInternetAccess: settings.internetAccess,
        confirm: true,
      });
      if (active.current) {
        setSettings(result);
        setInternet(result.internetAccess ?? false);
      }
    } catch (error) {
      if (active.current) setError(getApiErrorMessage(error));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  }
  const changed = settings?.internetAccess != null && internet !== settings.internetAccess;
  return (
    <section className="space-y-5 rounded-2xl bg-card p-5" aria-busy={busy}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">{copy.title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{copy.description}</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t.servers.networks.refresh}
          disabled={busy}
          onClick={() => setAttempt((value) => value + 1)}
        >
          <Icon name="refresh" className={`size-4 ${busy ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {error && (
        <p role="alert" className="break-words text-sm text-danger">
          {error}
        </p>
      )}
      {!settings && busy ? (
        <div className="h-20 animate-pulse rounded-xl bg-muted/40" />
      ) : (
        settings && (
          <>
            <div className="flex items-start gap-3 rounded-xl bg-muted/30 p-4">
              <Checkbox
                id={checkboxId}
                checked={internet}
                disabled={busy || settings.internetAccess == null}
                onCheckedChange={setInternet}
              />
              <div>
                <label htmlFor={checkboxId} className="cursor-pointer text-sm font-medium">
                  {copy.internet}
                </label>
                <p className="mt-1 text-sm text-muted-foreground">{copy.internetHint}</p>
                {settings.internetAccess == null && (
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t.billing.resourceOverview.unavailable}
                  </p>
                )}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-medium">{copy.routing}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{copy.routingHint}</p>
              {settings.ingressPorts.length > 0 && (
                <p className="mt-3 text-xs tabular-nums text-muted-foreground">
                  {copy.ports}: {settings.ingressPorts.join(", ")}
                </p>
              )}
            </div>
            {changed && (
              <div className="space-y-3 rounded-xl bg-warning/5 p-4">
                <p className="text-sm text-muted-foreground">{copy.confirmHint}</p>
                <Button disabled={busy} onClick={() => void save()}>
                  {copy.save}
                </Button>
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}
