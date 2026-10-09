"use client";

import { useEffect, useId, useState } from "react";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/Checkbox";
import { Textarea } from "@/components/ui/textarea";
import { systemApi } from "@/lib/api/system";
import { ManagedControlPanel, ConnectionValue } from "./ManagedControlPanel";
import { useManagedServerResource } from "./useManagedServerResource";

export function ManagedServerNetwork({ serverId }: { serverId: string }) {
  const { t } = useI18n();
  const copy = t.billing.workspaces.network;
  const common = t.servers.managedControls,
    network = common.network;
  const resource = useManagedServerResource(serverId, systemApi.getServerNetworkSettings);
  const settings = resource.data;
  const checkboxId = useId(),
    egressId = useId();
  const [internet, setInternet] = useState(false);
  const [rules, setRules] = useState("*");
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!settings) return;
    setInternet(settings.internetAccess ?? false);
    setRules(settings.egress?.length ? settings.egress.join("\n") : "*");
  }, [settings]);
  const egress = [
    ...new Set(
      rules
        .split(/\r?\n/)
        .map((line) => line.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
  const validRules =
    egress.length > 0 &&
    egress.length <= 50 &&
    egress.every((host) => host.length <= 253 && !/[\s/\\:@?#\x00]/.test(host)) &&
    (!egress.includes("*") || egress.length === 1);
  const canEditRules = settings?.egress != null && !!settings.revision;
  const rulesChanged =
    internet &&
    canEditRules &&
    JSON.stringify(egress) !== JSON.stringify([...(settings?.egress ?? [])].sort());
  const changed =
    settings?.internetAccess != null && (internet !== settings.internetAccess || rulesChanged);
  async function save() {
    if (settings?.internetAccess == null || (internet && canEditRules && !validRules)) return;
    setNotice(null);
    await resource.run(
      () =>
        systemApi.updateServerNetworkSettings(serverId, {
          internetAccess: internet,
          expectedInternetAccess: settings.internetAccess!,
          confirm: true,
          ...(settings.revision ? { expectedRevision: settings.revision } : {}),
          ...(internet && canEditRules ? { egress } : {}),
        }),
      (result) => {
        resource.replace(result);
        setNotice(common.saved);
      },
    );
  }
  return (
    <ManagedControlPanel
      title={copy.title}
      description={copy.description}
      icon="network"
      {...resource}
    >
      {!settings && resource.busy && <div className="h-32 animate-pulse rounded-xl bg-muted/40" />}
      {settings && (
        <>
          <div className="flex items-start gap-3 rounded-xl bg-muted/30 p-4">
            <Checkbox
              id={checkboxId}
              checked={internet}
              disabled={resource.busy || settings.internetAccess == null}
              onCheckedChange={setInternet}
            />
            <div>
              <label htmlFor={checkboxId} className="text-sm font-medium">
                {copy.internet}
              </label>
              <p className="mt-1 text-sm text-muted-foreground">{copy.internetHint}</p>
              {settings.internetAccess == null && (
                <p className="mt-2 text-sm text-muted-foreground">{common.unavailable}</p>
              )}
            </div>
          </div>
          <div className="space-y-2">
            <label htmlFor={egressId} className="text-sm font-medium">
              {network.egress}
            </label>
            <p className="text-xs text-muted-foreground">{network.egressHint}</p>
            <Textarea
              id={egressId}
              dir="ltr"
              variant="filled"
              className="bg-muted/40 font-mono text-xs"
              rows={4}
              value={rules}
              onChange={(event) => setRules(event.target.value)}
              disabled={resource.busy || !internet || !canEditRules}
              maxLength={13000}
              spellCheck={false}
            />
            {!canEditRules && (
              <p className="text-xs text-muted-foreground">{network.rulesUnavailable}</p>
            )}
            {internet && !validRules && (
              <p role="alert" className="text-xs text-danger">
                {network.invalidRules}
              </p>
            )}
          </div>
          {changed && (
            <div className="space-y-3 rounded-xl bg-warning/10 p-4">
              <p className="text-sm">{network.confirm}</p>
              <Button
                disabled={resource.busy || (internet && canEditRules && !validRules)}
                onClick={() => void save()}
              >
                {common.save}
              </Button>
            </div>
          )}
          {notice && (
            <p role="status" className="text-sm text-success">
              {notice}
            </p>
          )}
          <div className="grid min-w-0 grid-cols-1 gap-4 @min-[32rem]/server-detail:grid-cols-2">
            <ConnectionValue
              label={network.privateIp}
              value={settings.privateIp ?? common.unavailable}
            />
            <ConnectionValue
              label={network.outboundIp}
              value={settings.outboundIp ?? common.unavailable}
            />
          </div>
          <div>
            <h3 className="text-sm font-medium">{network.outboundMode}</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              {settings.outboundMode === "managed"
                ? network.managed
                : settings.outboundMode === "custom"
                  ? network.custom
                  : common.unavailable}
            </p>
          </div>
          <div>
            <h3 className="text-sm font-medium">{copy.routing}</h3>
            <p className="mt-1 text-sm text-muted-foreground">{network.routingHint}</p>
            <p className="mt-3 break-words text-xs text-muted-foreground">
              {copy.ports}:{" "}
              {settings.ingressAll
                ? network.allPorts
                : settings.ingressPorts.length
                  ? settings.ingressPorts.join(", ")
                  : network.noPorts}
            </p>
          </div>
        </>
      )}
    </ManagedControlPanel>
  );
}
