"use client";

import { useEffect, useRef, useState } from "react";
import { settingsApi } from "@/lib/api";
import { useSession } from "@/lib/auth-client";
import { useServerSelection, ServerSelectorView, type ServerOption } from "@/components/shared/ServerSelector";
import { Button } from "@/components/ui/button";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";
import { useI18n, interpolate } from "@/components/i18n-provider";

export function DeployDefaults() {
  const { showToast } = useToast();
  const { t } = useI18n();
  const { data: session } = useSession();
  const contextKey = `${session?.user.id ?? "local"}:${session?.session.activeOrganizationId ?? ""}`;
  const contextRef = useRef(contextKey);
  contextRef.current = contextKey;
  const [saved, setSaved] = useState<{ contextKey: string; serverId: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setStateError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const loading = saved?.contextKey !== contextKey;
  const serverId = !loading ? saved.serverId : null;
  useEffect(() => {
    let active = true;
    setStateError(null);
    void settingsApi.get().then(settings => {
      if (active) setSaved({ contextKey, serverId: settings.defaultServerId });
    }).catch(() => { if (active) setStateError(t.settings.deployDefaults.toast.failed); });
    return () => { active = false; };
  }, [contextKey, revision, t.settings.deployDefaults.toast.failed]);

  async function save(server: ServerOption | null) {
    if (saving) return;
    const owner = contextKey;
    setSaving(true);
    try {
      await settingsApi.updateDeployDefaults({
        defaultDeployTarget: server ? (server.raw.managed ? "cloud" : "server") : null,
        defaultServerId: server?.id ?? null,
      });
      if (contextRef.current !== owner) return;
      setSaved({ contextKey, serverId: server?.id ?? null });
      showToast(server ? interpolate(t.settings.deployDefaults.toast.setTo, { label: server.name })
        : t.settings.deployDefaults.toast.cleared, "success", t.settings.common.toast.defaults);
    } catch {
      if (contextRef.current === owner) showToast(t.settings.deployDefaults.toast.failed, "error", t.settings.common.toast.defaults);
    } finally {
      setSaving(false);
    }
  }
  const selection = useServerSelection({ value: serverId, disabled: loading || saving, onSelect: server => { void save(server); } });
  return (
    <SettingsSection icon="rocket" title={t.settings.deployDefaults.title}
      description={t.settings.deployDefaults.description} iconBg="bg-primary/10" iconColor="text-primary" collapsible>
      {error ? <div role="alert" className="space-y-2 text-sm text-danger">
        <p>{error}</p><Button variant="secondary" size="sm" onClick={() => setRevision(value => value + 1)}>{t.billing.plansRoute.tryAgain}</Button>
      </div> : loading ? <div aria-busy="true" className="h-16 animate-pulse rounded-xl bg-muted/50" />
        : <ServerSelectorView selection={selection} label={t.settings.deployDefaults.defaultServer} />}
      {serverId && <Button variant="ghost" size="sm" disabled={saving} onClick={() => void save(null)}>{t.settings.deployDefaults.clearDefault}</Button>}
    </SettingsSection>
  );
}
