"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  networkFirewallRules,
  networkFirewallTemplate,
  networkAccessAllowed,
  type InfrastructureProviderId,
  type NetworkFirewallMember,
  type NetworkFirewallScope,
} from "@repo/core";
import { BlurIp } from "@/components/BlurIp";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";
import { copyText } from "@/lib/clipboard";
import { InfrastructureProviderLogo } from "../InfrastructureProviderLogo";
import { NetworkDiagnosticText } from "./NetworkSetupProgress";

export interface NetworkFirewallServer extends NetworkFirewallMember {
  name: string;
  providerId?: InfrastructureProviderId;
}

/** All server rules remain visible, shared by final review and connection diagnostics. */
export function NetworkFirewallRules({
  servers,
  network = { mode: "wireguard" },
  failed = false,
  embedded = false,
  children,
}: {
  servers: NetworkFirewallServer[];
  network?: NetworkFirewallScope;
  failed?: boolean;
  embedded?: boolean;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const m = t.servers.networks.managed;
  const f = m.firewallRules;
  const a = t.servers.networks.access;
  const native = network.mode === "native";
  const isolated = network.mode === "wireguard" && network.access?.rules.length === 0;
  const id = useId();
  const [copied, setCopied] = useState<string | null>(null);
  const [copyError, setCopyError] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  if (!servers.length) return null;
  const groups = servers.map((server) => ({
    server,
    ...networkFirewallRules(servers, server.serverId, network),
    template: networkFirewallTemplate(servers, server.serverId, network),
  }));
  const completeTemplate = groups.every(
    (group) => group.template || (!group.rules.length && !group.pendingServerIds.length),
  )
    ? groups
        .filter((group) => group.template)
        .map(({ server, template }) => `${f.server}: ${server.name}\n${template}`)
        .join("\n\n") || null
    : null;
  const pending = groups.some((group) => group.pendingServerIds.length > 0);

  async function copy(key: string, value: string) {
    setCopyError(false);
    try {
      await copyText(value);
      if (timer.current) clearTimeout(timer.current);
      setCopied(key);
      timer.current = setTimeout(() => setCopied(null), 1600);
    } catch {
      setCopied(null);
      setCopyError(true);
    }
  }
  function valueCell(value: string, label: string, key: string, address = false) {
    return (
      <span className="inline-flex max-w-full items-center gap-1">
        <span className="min-w-0 break-all font-mono text-xs text-foreground" dir="ltr">
          {address ? <BlurIp>{value}</BlurIp> : value}
        </span>
        <button
          type="button"
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          aria-label={`${f.copy} ${label}`}
          title={copied === key ? f.copied : f.copy}
          onClick={() => void copy(key, value)}
        >
          {copied === key ? <UiIcon name="check" className="size-3.5" /> : <UiIcon name="copy" className="size-3.5" />}
        </button>
      </span>
    );
  }

  return (
    <section
      className={`@container/firewall min-w-0 space-y-5 ${embedded ? "" : "rounded-2xl bg-card p-5 sm:p-7"}`}
      aria-labelledby={`${id}-title`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={`grid size-9 shrink-0 place-items-center rounded-xl ${isolated ? "bg-muted text-muted-foreground" : "bg-warning/10 text-warning"}`}
          >
            <UiIcon name="shield" className="size-4" aria-hidden="true" />
          </span>
          <div>
            <h3 id={`${id}-title`} className="text-lg font-semibold">
              {f.title}
            </h3>
            <p
              className={`mt-1 text-sm font-medium ${isolated ? "text-muted-foreground" : "text-warning"}`}
            >
              {isolated ? a.noConnections : f.required}
            </p>
          </div>
        </div>
        {!isolated && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={!completeTemplate}
            onClick={() => completeTemplate && void copy("all", completeTemplate)}
          >
            {copied === "all" ? <UiIcon name="check" /> : <UiIcon name="copy" />}
            {copied === "all" ? f.copied : f.copyAllRules}
          </Button>
        )}
      </div>
      {failed && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-xl bg-warning/5 p-3 text-sm leading-relaxed"
        >
          <UiIcon name="alert-circle" className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <div>
            <p className="font-medium text-warning">{m.transportFailedTitle}</p>
            <p className="mt-1 text-muted-foreground">
              {native ? f.nativeFailedHint : m.transportFailedHint}
            </p>
          </div>
        </div>
      )}
      <ul className="divide-y divide-border/50">
        {groups.map(({ server, rules, template }, index) => {
          const serverTitle = `${id}-server-${index}`;
          const localAddress =
            rules.find((rule) => rule.direction === "inbound")?.destination ??
            (native ? server.privateIp : server.endpoint);
          return (
            <li key={server.serverId} className="min-w-0 py-5 first:pt-0 last:pb-0">
              <section aria-labelledby={serverTitle}>
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted/40">
                      <InfrastructureProviderLogo providerId={server.providerId ?? "custom"} />
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                        <h4 id={serverTitle} className="break-words text-sm font-medium">
                          <NetworkDiagnosticText value={server.name} />
                        </h4>
                        {localAddress && (
                          <>
                            <span aria-hidden="true" className="h-3 w-px bg-border" />
                            {valueCell(
                              localAddress,
                              native ? t.servers.networks.privateAddress : m.endpoint,
                              `${server.serverId}-local`,
                              true,
                            )}
                          </>
                        )}
                      </div>
                      {native && (
                        <p className="mt-1 break-words text-xs text-muted-foreground">
                          {t.servers.networks.interfaceName}:{" "}
                          {server.interfaceName || f.privateInterfaceHint}
                        </p>
                      )}
                    </div>
                  </div>
                  {(rules.length > 0 || pending) && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={!template}
                      onClick={() => template && void copy(server.serverId, template)}
                    >
                      {copied === server.serverId ? <UiIcon name="check" /> : <UiIcon name="copy" />}
                      {copied === server.serverId ? f.copied : f.copyRules}
                    </Button>
                  )}
                </div>
                {network.mode === "wireguard" && network.access && (
                  <dl className="mb-4 space-y-2 text-sm">
                    {(["outgoing", "incoming"] as const).map((direction) => {
                      const allowed = servers.filter((peer) =>
                        direction === "outgoing"
                          ? networkAccessAllowed(network.access, server.serverId, peer.serverId)
                          : networkAccessAllowed(network.access, peer.serverId, server.serverId),
                      );
                      return (
                        <div
                          key={direction}
                          className="flex flex-wrap items-baseline gap-x-2 gap-y-1"
                        >
                          <dt className="text-muted-foreground">{a[direction]}:</dt>
                          <dd>
                            {allowed.length
                              ? allowed.map((peer, peerIndex) => (
                                  <span
                                    key={peer.serverId}
                                    className="inline-flex items-center gap-2"
                                  >
                                    {peerIndex > 0 && (
                                      <span
                                        aria-hidden="true"
                                        className="mx-2 text-muted-foreground"
                                      >
                                        ·
                                      </span>
                                    )}
                                    <NetworkDiagnosticText value={peer.name} />
                                  </span>
                                ))
                              : a.none}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                )}
                {!rules.length && !pending && (
                  <p className="text-sm text-muted-foreground">{a.empty}</p>
                )}
                {rules.length > 0 && (
                  <div className="grid gap-3 @xl/firewall:grid-cols-2">
                    {(["inbound", "outbound"] as const).map((direction) => {
                      const DirectionIcon = direction === "inbound" ? "arrow-down-left" : "arrow-up-right";
                      const peerLabel = direction === "inbound" ? f.sourceCidr : f.destinationCidr;
                      // Native TCP and UDP probes share the same addresses and ports.
                      const visibleRules = rules.filter(
                        (rule) =>
                          rule.direction === direction && rule.protocol === "udp" && !rule.reply,
                      );
                      return (
                        <section
                          key={direction}
                          className="min-w-0 rounded-xl bg-muted/25 p-3"
                          aria-labelledby={`${serverTitle}-${direction}`}
                        >
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                            <div className="flex items-center gap-2">
                              <span className="grid size-6 shrink-0 place-items-center rounded-md bg-info/10 text-info">
                                <UiIcon name={DirectionIcon} className="size-3.5" aria-hidden="true" />
                              </span>
                              <h5
                                id={`${serverTitle}-${direction}`}
                                className="text-sm font-semibold"
                              >
                                {f[direction]}
                              </h5>
                            </div>
                            <span className="text-xs text-muted-foreground">
                              {f.allow} · {native ? "TCP / UDP" : "UDP"}
                            </span>
                          </div>
                          <div className="flex items-start justify-between gap-2 text-xs text-muted-foreground">
                            <span>{peerLabel}</span>
                            <span className="max-w-20 shrink-0 text-end">{f.destinationPort}</span>
                          </div>
                          <ul className="mt-1 divide-y divide-border/40">
                            {visibleRules.map((rule) => {
                              const peer = servers.find(
                                (item) => item.serverId === rule.peerServerId,
                              )!;
                              const cidr = direction === "inbound" ? rule.source : rule.destination;
                              const key = `${server.serverId}-${direction}-${peer.serverId}`;
                              return (
                                <li
                                  key={peer.serverId}
                                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 py-2 last:pb-0"
                                >
                                  <div className="min-w-0">
                                    <p className="mb-0.5 break-words text-xs text-muted-foreground">
                                      <NetworkDiagnosticText value={peer.name} />
                                    </p>
                                    {valueCell(cidr, peerLabel, `${key}-address`, true)}
                                  </div>
                                  {valueCell(
                                    String(rule.destinationPort),
                                    f.destinationPort,
                                    `${key}-port`,
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        </section>
                      );
                    })}
                  </div>
                )}
              </section>
            </li>
          );
        })}
      </ul>
      {pending && (
        <p
          role="status"
          className="rounded-xl bg-muted/40 p-3 text-sm leading-relaxed text-muted-foreground"
        >
          {f.pending}
        </p>
      )}
      <details className="group/firewall-guidance">
        <summary className="flex min-h-10 cursor-pointer list-none items-center justify-between gap-3 rounded-lg text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 [&::-webkit-details-marker]:hidden">
          {f.guidanceTitle}
          <UiIcon name="chevron-down"
            aria-hidden="true"
            className="size-4 shrink-0 transition-transform group-open/firewall-guidance:rotate-180"
          />
        </summary>
        <div className="mt-3 space-y-2 text-sm leading-relaxed text-muted-foreground">
          {!isolated && <p className="font-medium text-foreground">{f.requiredHint}</p>}
          {!isolated && <p>{native ? f.nativeDescription : f.description}</p>}
          {!isolated && network.mode === "wireguard" && network.access && <p>{a.transportHint}</p>}
          {network.mode === "wireguard" && network.access && <p>{a.enforcedHint}</p>}
          {!isolated && (
            <p>
              {f.sourcePort}: <span className="text-foreground">{f.any}</span>
            </p>
          )}
          {native && (
            <div className="flex items-start gap-2.5 rounded-xl bg-muted/25 p-3">
              <UiIcon name="arrows-left-right" className="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
              <div className="min-w-0 space-y-1.5">
                <p className="font-medium text-foreground">
                  {f.returnTraffic} · {f.inbound} / {f.outbound}
                </p>
                <p>{f.nativeReturnHint}</p>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="inline-flex items-center gap-1">
                    {f.sourcePort}:{" "}
                    {valueCell(String(network.probePort), f.sourcePort, "reply-port")}
                  </span>
                  <span>
                    {f.destinationPort}: {f.any}
                  </span>
                </div>
              </div>
            </div>
          )}
          <p>{native ? f.nativeScopeHint : f.scopeHint}</p>
          <p>{native ? f.nativeFirewallHint : m.firewallHint}</p>
        </div>
      </details>
      {children && <div className="border-t border-border/50 pt-4">{children}</div>}
      <span className="sr-only" role="status">
        {copied ? f.copied : ""}
      </span>
      {copyError && (
        <p role="alert" className="text-sm text-danger">
          {f.copyFailed}
        </p>
      )}
    </section>
  );
}
