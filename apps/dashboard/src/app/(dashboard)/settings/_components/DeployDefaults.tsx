"use client";

import { useState, useEffect, useCallback } from "react";
import { Check, Loader2, Server, Cloud, Cpu, Rocket, X } from "lucide-react";
import { BlurIp } from "@/components/BlurIp";
import { settingsApi } from "@/lib/api";
import { systemApi } from "@/lib/api/system";
import type { ServerInfo } from "@/lib/api/system";
import type { DefaultDeployTarget } from "@/lib/api/settings";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";
import { useI18n, interpolate } from "@/components/i18n-provider";

// Static target options. "server" gets a server-id sub-picker below.
const TARGET_OPTIONS: {
  value: DefaultDeployTarget;
  icon: React.ElementType;
}[] = [
  { value: "local", icon: Cpu },
  { value: "server", icon: Server },
  { value: "cloud", icon: Cloud },
];

export function DeployDefaults() {
  const { showToast } = useToast();
  const { t } = useI18n();
  const [target, setTarget] = useState<DefaultDeployTarget | null>(null);
  const [serverId, setServerId] = useState<string | null>(null);
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const [res, serverList] = await Promise.all([
        settingsApi.get(),
        systemApi.listServers().catch(() => [] as ServerInfo[]),
      ]);
      setTarget(res?.defaultDeployTarget ?? null);
      setServerId(res?.defaultServerId ?? null);
      setServers(serverList);
    } catch {
      /* silent */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Save the picked target. For target='server' we require a serverId;
  // we don't auto-pick the first server because that hides the choice
  // from the user - they should select one explicitly.
  async function save(nextTarget: DefaultDeployTarget | null, nextServerId: string | null) {
    if (nextTarget === "server" && !nextServerId) {
      showToast(t.settings.deployDefaults.toast.pickServer, "error", t.settings.common.toast.defaults);
      return;
    }
    setSaving(true);
    const prevTarget = target;
    const prevServerId = serverId;
    setTarget(nextTarget);
    setServerId(nextTarget === "server" ? nextServerId : null);
    try {
      await settingsApi.updateDeployDefaults({
        defaultDeployTarget: nextTarget,
        defaultServerId: nextTarget === "server" ? nextServerId : null,
      });
      showToast(
        nextTarget === null
          ? t.settings.deployDefaults.toast.cleared
          : interpolate(t.settings.deployDefaults.toast.setTo, {
              label: labelFor(nextTarget, nextServerId, servers, t.settings.deployDefaults.labelFor),
            }),
        "success",
        t.settings.common.toast.defaults,
      );
    } catch {
      setTarget(prevTarget);
      setServerId(prevServerId);
      showToast(t.settings.deployDefaults.toast.failed, "error", t.settings.common.toast.defaults);
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingsSection
      icon={Rocket}
      title={t.settings.deployDefaults.title}
      description={t.settings.deployDefaults.description}
      iconBg="bg-blue-500/10"
      iconColor="text-blue-500"
      collapsible
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="size-4 animate-spin" />
          {t.settings.deployDefaults.loading}
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground mb-4">
            {t.settings.deployDefaults.intro}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {TARGET_OPTIONS.map(({ value, icon: ModeIcon }) => {
              const active = target === value;
              return (
                <button
                  key={value}
                  onClick={() => save(value, value === "server" ? serverId : null)}
                  disabled={saving}
                  className={`relative text-start rounded-xl border p-4 transition-all ${
                    active
                      ? "border-primary/50 bg-primary/5 ring-1 ring-primary/20"
                      : "border-border/50 bg-card hover:bg-muted/40 hover:border-border"
                  } disabled:opacity-50`}
                >
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
                    <ModeIcon className="size-4 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">{t.settings.deployDefaults.targets[value].label}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{t.settings.deployDefaults.targets[value].desc}</p>
                  {active && (
                    <div className="absolute top-3 end-3">
                      <Check className="size-4 text-primary" />
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          {/* Server sub-picker - only when target=server */}
          {target === "server" && (
            <div className="mt-4 rounded-xl border border-border/50 bg-muted/20 p-3">
              <p className="text-xs font-medium text-muted-foreground mb-2 px-1">
                {t.settings.deployDefaults.defaultServer}
              </p>
              {servers.length === 0 ? (
                <p className="text-xs text-muted-foreground px-1 py-1.5">
                  {t.settings.deployDefaults.noServers}
                </p>
              ) : (
                <div className="space-y-1.5">
                  {servers.map((s) => {
                    const isSelected = serverId === s.id;
                    return (
                      <button
                        key={s.id}
                        type="button"
                        disabled={saving}
                        onClick={() => save("server", s.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-start transition-all ${
                          isSelected
                            ? "bg-primary/10 border border-primary/30"
                            : "bg-card/60 border border-border/30 hover:border-primary/20 hover:bg-muted/30"
                        } disabled:opacity-50`}
                      >
                        <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 ${
                          isSelected ? "bg-primary/15 text-primary" : "bg-muted/50 text-muted-foreground"
                        }`}>
                          <Server className="size-3.5" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">
                            {s.name || s.sshHost}
                          </p>
                          <p className="text-[11px] text-muted-foreground">
                            {s.sshUser || "root"}@<BlurIp>{s.sshHost}</BlurIp>:{s.sshPort || 22}
                          </p>
                        </div>
                        {isSelected && (
                          <Check className="size-4 text-primary shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Clear */}
          {target !== null && (
            <button
              type="button"
              onClick={() => save(null, null)}
              disabled={saving}
              className="mt-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
            >
              <X className="size-3" />
              {t.settings.deployDefaults.clearDefault}
            </button>
          )}
        </>
      )}
    </SettingsSection>
  );
}

function labelFor(
  target: DefaultDeployTarget,
  serverId: string | null,
  servers: ServerInfo[],
  labels: { yourServer: string; cloud: string; local: string },
): string {
  if (target === "server") {
    const s = servers.find((srv) => srv.id === serverId);
    return s ? (s.name || s.sshHost) : labels.yourServer;
  }
  if (target === "cloud") return labels.cloud;
  return labels.local;
}
