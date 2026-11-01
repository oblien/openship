"use client";

import { useEffect, useRef, useState } from "react";
import type { CloudWorkspaceSummary, ServerDetail } from "@repo/contracts";
import { Icon } from "@repo/ui/icons";
import { useI18n } from "@/components/i18n-provider";
import { OptionCard } from "@/components/shared/OptionCard";
import { ServerPicker } from "@/components/shared/ServerPicker";
import { Button } from "@/components/ui/button";
import { useCloud } from "@/context/CloudContext";
import { usePlatform } from "@/context/PlatformContext";
import { useSession } from "@/lib/auth-client";
import { getApiErrorMessage } from "@/lib/api/client";
import { systemApi } from "@/lib/api/system";
import { ManagedServerPurchase } from "./managed/ManagedServerPurchase";

export type ServerAcquisitionMode = "connected" | "managed";

/** The same choice appears on the server page and in inline setup dialogs. */
export function ServerAcquisitionPicker({ value, onChange, stacked = false }: {
  value: ServerAcquisitionMode;
  onChange: (value: ServerAcquisitionMode) => void;
  stacked?: boolean;
}) {
  const { t } = useI18n();
  const copy = t.servers.acquire;
  return (
    <div className={`grid items-stretch gap-3 ${stacked ? "" : "sm:grid-cols-2"}`}>
      {(["connected", "managed"] as const).map(mode => (
        <OptionCard key={mode} value={mode} selected={value === mode} onSelect={() => onChange(mode)}
          icon={<Icon name={mode === "managed" ? "cloud" : "server"} className="size-5" />}
          label={copy[mode].label} description={copy[mode].description} />
      ))}
    </div>
  );
}

/** Cloud owns subscriptions and provisioning; linking only adds a local server
 * destination. Both newly purchased and existing servers use the same picker. */
export function ManagedServerSetup({ onReady, onCancel, preserveProject = false }: {
  onReady: (server: CloudWorkspaceSummary, needsPlan: boolean, checkoutUrl?: string) => void | Promise<void>;
  onCancel?: () => void;
  preserveProject?: boolean;
}) {
  const { t } = useI18n();
  const copy = t.servers.acquire;
  const { selfHosted } = usePlatform();
  const cloud = useCloud();
  const { data: session } = useSession();
  const contextKey = `${session?.user.id ?? "local"}:${session?.session.activeOrganizationId ?? ""}`;
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const [available, setAvailable] = useState<{ contextKey: string; servers: ServerDetail[] } | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createNew, setCreateNew] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    let active = true;
    setAvailable(null);
    setSelectedId(null);
    setCreateNew(false);
    setError(null);
    if (selfHosted && cloud.connected) {
      void systemApi.availableManagedServers().then(result => {
        if (active) {
          setAvailable({ contextKey, servers: result.servers });
          if (result.servers.length === 1) setSelectedId(result.servers[0]!.id);
        }
      }).catch(error => { if (active) setError(getApiErrorMessage(error)); });
    }
    return () => { active = false; };
  }, [selfHosted, cloud.connected, contextKey, revision]);

  async function connect() {
    if (!selectedId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const owner = contextKey;
    try {
      const server = await systemApi.connectManagedServer({ serverId: selectedId });
      if (contextRef.current === owner) await onReady(server, server.state === "needs_plan");
    } catch (error) {
      if (contextRef.current === owner) setError(getApiErrorMessage(error));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  if (selfHosted && !cloud.connected) return (
    <div className="space-y-4 rounded-2xl bg-card p-5">
      <p className="text-sm text-muted-foreground">{copy.signInHint}</p>
      <div className="flex justify-end gap-2">
        {onCancel && <Button variant="secondary" onClick={onCancel}>{t.billing.deployGate.close}</Button>}
        <Button disabled={cloud.loading || cloud.connecting} onClick={cloud.startConnect}>
          {(cloud.loading || cloud.connecting) && <Icon name="spinner" className="size-4 animate-spin" />}
          {t.billing.unavailable.notConnected.connect}
        </Button>
      </div>
    </div>
  );

  if (selfHosted && available?.contextKey !== contextKey) return (
    <div className="space-y-3 rounded-2xl bg-card p-5">
      {error ? <><p role="alert" className="text-sm text-danger">{error}</p><Button variant="secondary" onClick={() => setRevision(value => value + 1)}>{t.billing.plansRoute.tryAgain}</Button></>
        : <div aria-busy="true" aria-label={t.widgets.shared.serverSelector.loadingServers} className="h-16 animate-pulse rounded-xl bg-muted/50" />}
    </div>
  );

  const servers = available?.servers ?? [];
  if (!selfHosted || createNew || servers.length === 0) return (
    <div className="space-y-3">
      {selfHosted && servers.length > 0 && <Button variant="ghost" size="sm" onClick={() => setCreateNew(false)}>{copy.chooseExisting}</Button>}
      <ManagedServerPurchase key={contextKey} onCancel={onCancel} preserveProject={preserveProject}
        onCheckoutStarted={(server, checkoutUrl) => { if (contextRef.current === contextKey) return onReady(server, true, checkoutUrl); }} />
    </div>
  );

  return (
    <div className="space-y-4 rounded-2xl bg-card p-5">
      <ServerPicker servers={servers} selectedId={selectedId} onSelect={server => setSelectedId(server.id)}
        label={copy.chooseExisting} disabled={busy} onAddServer={() => setCreateNew(true)}
        addServerLabel={t.billing.workspaces.create} />
      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        {onCancel && <Button variant="secondary" disabled={busy} onClick={onCancel}>{t.billing.deployGate.close}</Button>}
        <Button disabled={busy || !selectedId} onClick={connect}>
          {busy && <Icon name="spinner" className="size-4 animate-spin" />}
          {copy.useServer}
        </Button>
      </div>
    </div>
  );
}
