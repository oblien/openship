"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Check,
  ChevronDown,
  CircleAlert,
  Gauge,
  Loader2,
  Minus,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import {
  NETWORK_LATENCY_SAMPLES,
  NETWORK_SPEED_DURATION_MS,
  NETWORK_SPEED_MAX_BYTES,
  setNetworkConnection,
  type ClusterNetworkReport,
  type ClusterSpeedTest,
  type NetworkFirewallScope,
  type NetworkAccessPolicy,
} from "@repo/core";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { BlurIp } from "@/components/BlurIp";
import { NetworkDiagnosticText } from "./NetworkSetupProgress";
import { ClusterNetworkTopology } from "./ClusterNetworkTopology";
import { ManagedNetworkTransportNotice } from "./ManagedNetworkTransportNotice";
import { NetworkFirewallRules } from "./NetworkFirewallRules";
import { networkLinks, type NetworkTopologyMember } from "./network-topology";
import { NetworkConnectionAccess } from "./NetworkConnectionAccess";

function CheckResult({ value }: { value?: boolean }) {
  const { t } = useI18n();
  const c = t.servers.networks;
  const Icon = value === true ? Check : value === false ? CircleAlert : Minus;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${value === true ? "text-success" : value === false ? "text-danger" : "text-muted-foreground"}`}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {value === true ? c.passed : value === false ? c.failed : c.diagnostics.notTested}
    </span>
  );
}
const metric = (value?: number | null, unit = "ms") =>
  value == null ? "—" : `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unit}`;

export function ClusterNetworkDiagnostics({
  members,
  report,
  running = false,
  observedAt,
  restored = false,
  onSpeedTest,
  speedDisabled = false,
  compact = false,
  statusText,
  hint,
  onHostSelect,
  network,
  showFirewallRules = true,
  onAccessChange,
  accessDisabled = false,
}: {
  members: NetworkTopologyMember[];
  report?: ClusterNetworkReport | null;
  running?: boolean;
  observedAt?: string | null;
  restored?: boolean;
  onSpeedTest?(pair: ClusterSpeedTest): void;
  speedDisabled?: boolean;
  compact?: boolean;
  statusText?: string;
  hint?: string;
  onHostSelect?(serverId: string): void;
  network?: NetworkFirewallScope;
  /** Setup review renders its rules and confirmation together above the host results. */
  showFirewallRules?: boolean;
  onAccessChange?(access: NetworkAccessPolicy): void;
  accessDisabled?: boolean;
}) {
  const { t } = useI18n();
  const c = t.servers.networks,
    d = c.diagnostics;
  const a = c.access;
  const access = network?.mode === "wireguard" ? network.access : undefined;
  const links = useMemo(() => networkLinks(members, report, access), [members, report, access]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState<boolean | null>(null);
  const showDetails = !compact || (detailsOpen ?? links.some((link) => link.state === "failed"));
  const failedHandshakes = report?.handshakes?.filter((peer) => !peer.ok) ?? [];
  const [focus, setFocus] = useState<string | null>(() =>
    members.length > 6 ? members[0]!.serverId : null,
  );
  const selected =
    links.find((link) => link.id === selectedId) ??
    links.find((link) => link.state === "failed") ??
    links[0];
  function select(id: string) {
    setSelectedId(id);
    setDetailsOpen(true);
    const link = links.find((item) => item.id === id);
    if (link && focus && focus !== link.source.serverId && focus !== link.target.serverId)
      setFocus(link.source.serverId);
  }
  return (
    <section className="@container/network-diagnostics min-w-0 space-y-4" aria-label={d.title}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{d.title}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {hint ?? (onAccessChange ? a.description : d.selectHint)}
          </p>
        </div>
        {focus && (
          <Button variant="ghost" size="sm" onClick={() => setFocus(null)}>
            {d.showAll}
          </Button>
        )}
      </div>
      <ClusterNetworkTopology
        members={members}
        links={links}
        report={report}
        selected={selected?.id ?? null}
        focusedServer={focus}
        onSelect={select}
        onFocus={(id) => {
          setFocus(id);
          onHostSelect?.(id);
          setSelectedId(
            links.find((link) => link.source.serverId === id || link.target.serverId === id)?.id ??
              null,
          );
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <div className="flex flex-wrap gap-4">
          <CheckResult value={true} />
          <CheckResult value={false} />
          <CheckResult />
        </div>
        <p>
          {restored
            ? d.restoredResults
            : (statusText ??
              (running
                ? d.testing
                : observedAt
                  ? interpolate(d.recordedAt, { time: new Date(observedAt).toLocaleString() })
                  : d.unmeasured))}
        </p>
      </div>
      {showFirewallRules && failedHandshakes.length > 0 && (
        <ManagedNetworkTransportNotice
          access={access}
          failed
          endpoints={members.map((member) => {
            const connection = report?.handshakes?.find(
              (peer) => peer.targetServerId === member.serverId,
            );
            return {
              ...member,
              endpoint: connection?.endpoint ?? member.endpoint,
              listenPort: connection?.port ?? member.listenPort,
            };
          })}
        />
      )}
      {showFirewallRules &&
        network?.mode === "native" &&
        !failedHandshakes.length &&
        links.some((link) => link.state === "failed") && (
          <NetworkFirewallRules failed network={network} servers={members} />
        )}
      {compact && selected && (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded-xl bg-card px-4 py-3 text-start text-sm font-medium"
          aria-expanded={showDetails}
          onClick={() => setDetailsOpen(!showDetails)}
        >
          <Settings2 className="size-4 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 flex-1">{onAccessChange ? a.manage : d.connectionDetails}</span>
          <ChevronDown
            className={`size-4 text-muted-foreground transition-transform ${showDetails ? "rotate-180" : ""}`}
            aria-hidden="true"
          />
        </button>
      )}
      {selected && showDetails && (
        <div className="min-w-0 rounded-2xl bg-card p-5 sm:p-6">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-0 flex-1 basis-56">
              <label className="mb-2 block text-xs text-muted-foreground">{d.connection}</label>
              <div className="flex items-center gap-2">
                <CustomSelect
                  className="min-w-0 flex-1"
                  aria-label={d.connection}
                  value={selected.id}
                  onChange={select}
                  variant="filled"
                  searchable
                  options={links.map((link) => ({
                    value: link.id,
                    label: `${link.source.name} ${link.accessMode === "forward" ? "→" : link.accessMode === "reverse" ? "←" : link.connected ? "↔" : "—"} ${link.target.name}${link.connected ? "" : ` · ${a.blocked}`}`,
                  }))}
                />
                {onAccessChange && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11 shrink-0 @lg/network-diagnostics:w-auto @lg/network-diagnostics:px-3"
                    aria-label={selected.connected ? a.remove : a.restore}
                    title={selected.connected ? a.remove : a.restore}
                    disabled={accessDisabled}
                    onClick={() =>
                      onAccessChange(
                        setNetworkConnection(
                          access,
                          members.map((member) => member.serverId),
                          selected.source.serverId,
                          selected.target.serverId,
                          selected.connected ? "blocked" : "both",
                        ),
                      )
                    }
                  >
                    {selected.connected ? <Trash2 /> : <Plus />}
                    <span className="hidden @lg/network-diagnostics:inline">
                      {selected.connected ? a.remove : a.restore}
                    </span>
                  </Button>
                )}
              </div>
            </div>
            {onSpeedTest && (
              <Button
                type="button"
                variant="secondary"
                disabled={speedDisabled || running || !selected.connected}
                onClick={() =>
                  onSpeedTest({
                    sourceServerId: selected.source.serverId,
                    targetServerId: selected.target.serverId,
                  })
                }
              >
                {running && report?.speedTest ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Gauge className="size-4" />
                )}
                {d.testSpeed}
              </Button>
            )}
          </div>
          {onAccessChange && (
            <NetworkConnectionAccess
              link={selected}
              memberIds={members.map((member) => member.serverId)}
              access={access}
              onChange={onAccessChange}
              disabled={accessDisabled}
            />
          )}
          {onSpeedTest && (
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              {interpolate(d.speedLimit, {
                size: String(NETWORK_SPEED_MAX_BYTES / 1024 / 1024),
                seconds: String(NETWORK_SPEED_DURATION_MS / 1000),
              })}
            </p>
          )}
          {(!onAccessChange || report) && (
            <div className="mt-5 grid gap-5 @2xl/network-diagnostics:grid-cols-2">
              {selected.directions.map(({ source, target, check, handshake, speed, allowed }) => (
                <div key={source.serverId} className="min-w-0 rounded-xl bg-muted/20 p-4">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <Link
                      href={`/servers/${source.serverId}`}
                      className="break-words hover:text-primary"
                    >
                      <NetworkDiagnosticText value={source.name} />
                    </Link>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                    <Link
                      href={`/servers/${target.serverId}`}
                      className="break-words hover:text-primary"
                    >
                      <NetworkDiagnosticText value={target.name} />
                    </Link>
                  </div>
                  <dl className="mt-4 space-y-2.5">
                    {(handshake || compact) && (
                      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                        <dt className="text-muted-foreground">{d.handshake}</dt>
                        <dd>
                          <CheckResult value={handshake?.ok} />
                        </dd>
                      </div>
                    )}
                    {!allowed && (
                      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                        <dt className="text-muted-foreground">{a.title}</dt>
                        <dd
                          className={
                            check?.policyPassed === true
                              ? "text-success"
                              : check?.policyPassed === false
                                ? "text-danger"
                                : "text-muted-foreground"
                          }
                        >
                          {check?.policyPassed === true
                            ? a.blockedVerified
                            : check?.reachable === true
                              ? a.unexpectedAccess
                              : a.notVerified}
                        </dd>
                      </div>
                    )}
                    {allowed &&
                      (!compact || check) &&
                      (["tcp", "udp", "mtu"] as const).map((key) => (
                        <div
                          key={key}
                          className="flex flex-wrap items-center justify-between gap-2 text-xs"
                        >
                          <dt className="text-muted-foreground">{key.toUpperCase()}</dt>
                          <dd>
                            <CheckResult value={check?.[key]} />
                          </dd>
                        </div>
                      ))}
                  </dl>
                  {allowed && compact && !check && (
                    <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
                      {d.privateChecksPending}
                    </p>
                  )}
                  {allowed && (!compact || check || speed) && (
                    <dl className="mt-4 grid grid-cols-2 gap-4 border-t border-border/40 pt-4">
                      {[
                        [
                          d.roundTrip,
                          metric(check?.latencyKind === "rtt" ? check.latencyMs : null),
                        ],
                        [d.packetLoss, metric(check?.packetLossPercent, "%")],
                        [d.jitter, metric(check?.jitterMs)],
                        [d.throughput, metric(speed?.megabitsPerSecond, "Mbps")],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <dt className="text-xs text-muted-foreground">{label}</dt>
                          <dd className="mt-1 text-sm font-medium tabular-nums">{value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                  {handshake && (
                    <div className="mt-4 border-t border-border/40 pt-3 text-xs text-muted-foreground">
                      <p>
                        {d.transport}:{" "}
                        <span className="font-mono">
                          <BlurIp>{handshake.endpoint}</BlurIp>:{handshake.port}/UDP
                        </span>
                      </p>
                      {handshake.lastHandshakeAt && (
                        <p className="mt-1">
                          {interpolate(d.handshakeAt, {
                            time: new Date(handshake.lastHandshakeAt).toLocaleString(),
                          })}
                        </p>
                      )}
                      {!handshake.ok && (
                        <p className="mt-2 leading-relaxed text-warning">
                          {interpolate(d.handshakeHelp, { port: String(handshake.port) })}
                        </p>
                      )}
                    </div>
                  )}
                  {(check?.message || speed?.message) && (
                    <p className="mt-3 text-xs leading-relaxed text-warning">
                      <NetworkDiagnosticText
                        value={[check?.message, speed?.message].filter(Boolean).join(" ")}
                      />
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
          {(!compact || !!report?.peers.length) && (
            <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
              {interpolate(d.samplesHint, { count: String(NETWORK_LATENCY_SAMPLES) })}
            </p>
          )}
        </div>
      )}
      {report?.hosts
        .filter((host) => !host.ok)
        .map((host) => (
          <p
            key={host.serverId}
            className="rounded-xl bg-warning/5 p-4 text-xs leading-relaxed text-warning"
          >
            <NetworkDiagnosticText
              value={`${members.find((member) => member.serverId === host.serverId)?.name ?? host.serverId}: ${host.message ?? c.failed}`}
            />
          </p>
        ))}
    </section>
  );
}
