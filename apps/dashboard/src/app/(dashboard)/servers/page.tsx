"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Server,
  Plus,
  Loader2,
  ArrowRight,
  KeyRound,
  Lock,
  Network,
  Boxes,
  Activity,
  Container,
  Globe,
  GitBranch,
  BookOpen,
  ExternalLink,
  Layers,
  MapPin,
} from "lucide-react";
import { systemApi } from "@/lib/api";
import { PageContainer } from "@/components/ui/PageContainer";
import { Tabs, type TabDef } from "@/components/ui/Tabs";
import { usePlatform } from "@/context/PlatformContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { ComingSoonPanel } from "./_components/coming-soon-panel";
import * as CountryFlags from "country-flag-icons/react/3x2";

const FLAGS = CountryFlags as Record<
  string,
  React.ComponentType<{ title?: string; className?: string }>
>;

type Reachability = "checking" | "online" | "offline";
type ServersTab = "servers" | "cluster" | "networking";

interface ServerEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  auth: "key" | "password" | null;
  country: string | null;
  /** The auto-registered host row ("This Server") — deploys run locally, not SSH. */
  isLocal: boolean;
  /** Projects currently deployed to this server (active deployment → this host). */
  projectCount: number;
}

/** Per-state colors: an ambient presence dot on the avatar + a word on the right. */
const STATUS: Record<Reachability, { dot: string; text: string }> = {
  online: { dot: "bg-success-solid", text: "text-success" },
  offline: { dot: "bg-danger-solid", text: "text-danger" },
  checking: { dot: "bg-warning-solid animate-pulse", text: "text-muted-foreground/70" },
};

export default function ServersPage() {
  const { t } = useI18n();
  const router = useRouter();
  const { deployMode } = usePlatform();
  const isDesktop = deployMode === "desktop";

  const [activeTab, setActiveTab] = useState<ServersTab>("servers");
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  /** Live reachability per server (see probeReachability). */
  const [reach, setReach] = useState<Record<string, Reachability>>({});
  /** Active (running) port-forward count per server — desktop-only. */
  const [forwardCounts, setForwardCounts] = useState<Record<string, number>>({});

  const fetchServers = useCallback(async () => {
    try {
      setLoading(true);
      const list = await systemApi.listServers();
      setServers(
        list.map((s) => ({
          id: s.id,
          name: s.name || s.sshHost,
          host: s.sshHost,
          port: s.sshPort ?? 22,
          user: s.sshUser ?? "root",
          auth: (s.sshAuthMethod as "key" | "password" | null) ?? null,
          country: s.country ?? null,
          isLocal: s.isLocal ?? false,
          projectCount: s.projectCount ?? 0,
        })),
      );
    } catch {
      setServers([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchServers();
  }, [fetchServers]);

  // Real reachability: seed every server to "checking", then probe each in
  // parallel and flip its dot as the probe resolves (mirrors the tunnel fan-out).
  useEffect(() => {
    if (servers.length === 0) return;
    let cancelled = false;
    setReach(Object.fromEntries(servers.map((s) => [s.id, "checking" as const])));
    servers.forEach((s) => {
      void systemApi
        .probeReachability(s.id)
        .then((r) => {
          if (!cancelled) setReach((prev) => ({ ...prev, [s.id]: r.reachable ? "online" : "offline" }));
        })
        .catch(() => {
          if (!cancelled) setReach((prev) => ({ ...prev, [s.id]: "offline" }));
        });
    });
    return () => {
      cancelled = true;
    };
  }, [servers]);

  // Active forward counts (desktop-only). Best-effort and per-server.
  useEffect(() => {
    if (!isDesktop || servers.length === 0) return;
    let cancelled = false;
    void Promise.all(
      servers.map(async (s) => {
        try {
          const rows = await systemApi.listTunnels(s.id);
          return [s.id, rows.filter((tn) => tn.running).length] as const;
        } catch {
          return [s.id, 0] as const;
        }
      }),
    ).then((entries) => {
      if (!cancelled) setForwardCounts(Object.fromEntries(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [isDesktop, servers]);

  const counts = servers.reduce(
    (acc, s) => {
      const st = reach[s.id] ?? "checking";
      acc[st] += 1;
      return acc;
    },
    { online: 0, offline: 0, checking: 0 } as Record<Reachability, number>,
  );

  const totalProjects = servers.reduce((sum, s) => sum + s.projectCount, 0);
  const regionCount = new Set(servers.map((s) => s.country).filter(Boolean)).size;
  const onlinePct = servers.length ? Math.round((counts.online / servers.length) * 100) : 0;

  const tabs: TabDef<ServersTab>[] = [
    { key: "servers", label: t.servers.tabsNav.servers, icon: Server },
    { key: "cluster", label: t.servers.tabsNav.cluster, icon: Boxes },
    { key: "networking", label: t.servers.tabsNav.networking, icon: Network },
  ];

  return (
    <PageContainer>
      {/* Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-2xl font-medium text-foreground/80" style={{ letterSpacing: "-0.2px" }}>
            {t.servers.list.title}
          </h1>
          <p className="text-sm text-muted-foreground/70 mt-1">{t.servers.list.subtitle}</p>
        </div>
        {activeTab === "servers" && (
          <button
            onClick={() => router.push("/servers/new")}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25"
          >
            <Plus className="size-4" />
            {t.servers.list.addServer}
          </button>
        )}
      </div>

      <Tabs tabs={tabs} value={activeTab} onChange={setActiveTab} className="mb-6" />

      {activeTab === "cluster" && (
        <ComingSoonPanel
          art="cluster"
          badge={t.servers.comingSoon.badge}
          title={t.servers.comingSoon.clusterTitle}
          body={t.servers.comingSoon.clusterBody}
        />
      )}

      {activeTab === "networking" && (
        <ComingSoonPanel
          art="network"
          badge={t.servers.comingSoon.badge}
          title={t.servers.comingSoon.networkingTitle}
          body={t.servers.comingSoon.networkingBody}
        />
      )}

      {activeTab === "servers" &&
        (loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : servers.length === 0 ? (
          // Empty state stands alone (no Quick Info card) and centers.
          <EmptyState onAdd={() => router.push("/servers/new")} />
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
            {/* ── LEFT COLUMN ── */}
            <div className="min-w-0">
              <div className="overflow-hidden rounded-2xl border border-border/50 bg-card divide-y divide-border/50">
                {servers.map((server) => {
                  const state = reach[server.id] ?? "checking";
                  const sm = STATUS[state];
                  const authLabel =
                    server.auth === "password"
                      ? t.servers.list.authPassword
                      : server.auth === "key"
                        ? t.servers.list.authKey
                        : null;
                  const AuthIcon = server.auth === "password" ? Lock : KeyRound;
                  const fwd = forwardCounts[server.id] ?? 0;
                  return (
                    <button
                      key={server.id}
                      onClick={() => router.push(`/servers/${server.id}`)}
                      className="group flex w-full items-center gap-3.5 px-5 py-3 text-start transition-colors hover:bg-muted/40"
                    >
                      {/* Avatar — full country flag when we can geolocate the IP, else glyph.
                          Fixed 36px slot keeps the name column aligned across rows. */}
                      {(() => {
                        const Flag = server.country ? FLAGS[server.country] : undefined;
                        return Flag ? (
                          <div className="flex size-9 shrink-0 items-center justify-center">
                            <Flag
                              title={server.country ?? undefined}
                              className="h-[18px] w-auto rounded-[2px] ring-1 ring-border/50"
                            />
                          </div>
                        ) : (
                          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-muted/60 transition-colors group-hover:bg-muted">
                            <Server className="size-[18px] text-foreground/70" />
                          </div>
                        );
                      })()}

                      {/* Name + host (fixed column — keeps meta aligned, no dead gap) */}
                      <div className="w-44 min-w-0 shrink-0 text-start lg:w-56">
                        <p className="truncate text-sm font-medium text-foreground">
                          {server.name}
                          {server.isLocal && (
                            <span className="ms-2 rounded bg-info/10 px-1.5 py-0.5 text-[10px] font-medium text-info align-middle">
                              {t.servers.list.thisServer}
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                          {server.isLocal ? t.servers.list.currentHost : server.host}
                        </p>
                      </div>

                      {/* Meta chips */}
                      <div className="flex min-w-0 flex-1 items-center gap-3 overflow-hidden">
                        <span
                          title={t.servers.list.projects}
                          className={`inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs ${
                            server.projectCount > 0
                              ? "bg-muted/60 text-foreground/80"
                              : "text-muted-foreground/60"
                          }`}
                        >
                          <Layers className="size-3.5" />
                          {server.projectCount}
                        </span>
                        {authLabel && (
                          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-muted/60 px-2 py-0.5 text-xs text-muted-foreground">
                            <AuthIcon className="size-3.5" />
                            {authLabel}
                          </span>
                        )}
                        {isDesktop && fwd > 0 && (
                          <span className="hidden shrink-0 items-center gap-1.5 text-xs text-muted-foreground md:inline-flex">
                            <Network className="size-3.5" />
                            {interpolate(t.servers.list.forwarding, { n: String(fwd) })}
                          </span>
                        )}
                      </div>

                      {/* Status state + arrow */}
                      <div className="flex shrink-0 items-center gap-4">
                        <span
                          title={t.servers.list[state]}
                          className={`inline-flex items-center gap-1.5 text-xs font-medium ${sm.text}`}
                        >
                          <span className={`size-1.5 rounded-full ${sm.dot}`} />
                          {t.servers.list[state]}
                        </span>
                        <ArrowRight className="size-4 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground rtl:rotate-180" />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── RIGHT COLUMN (Sticky) ── */}
            <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <div className="bg-card rounded-2xl border border-border/50">
              <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
                <div className="w-9 h-9 bg-muted rounded-xl flex items-center justify-center">
                  <Activity className="size-[18px] text-muted-foreground" />
                </div>
                <div>
                  <h2 className="font-semibold text-foreground text-[15px]">{t.servers.list.quickInfo}</h2>
                  <p className="text-xs text-muted-foreground">{t.servers.list.serverOverview}</p>
                </div>
              </div>
              <div className="p-5 space-y-5">
                {/* Health ratio — online / total with a progress bar. */}
                <div>
                  <div className="flex items-baseline justify-between">
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-2xl font-semibold text-foreground tabular-nums">{counts.online}</span>
                      <span className="text-sm text-muted-foreground">
                        / {servers.length} {t.servers.list.online}
                      </span>
                    </div>
                    <span className="text-xs font-medium text-muted-foreground tabular-nums">{onlinePct}%</span>
                  </div>
                  <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-success-solid transition-[width] duration-500"
                      style={{ width: `${onlinePct}%` }}
                    />
                  </div>
                  {counts.offline > 0 && (
                    <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-danger">
                      <span className="size-1.5 rounded-full bg-danger-solid" />
                      {counts.offline} {t.servers.list.offline}
                    </p>
                  )}
                </div>

                {/* Fleet stats. */}
                <div className="space-y-0.5 border-t border-border/50 pt-4">
                  {[
                    { icon: Server, label: t.servers.list.totalServers, value: servers.length },
                    { icon: Layers, label: t.servers.list.projects, value: totalProjects },
                    { icon: MapPin, label: t.servers.list.regions, value: regionCount },
                  ].map((row) => (
                    <div key={row.label} className="flex items-center justify-between py-1.5">
                      <span className="inline-flex items-center gap-2.5 text-sm text-muted-foreground">
                        <row.icon className="size-4 text-muted-foreground/60" />
                        {row.label}
                      </span>
                      <span className="text-sm font-medium text-foreground tabular-nums">{row.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      ))}
    </PageContainer>
  );
}

/** No-servers illustration + primer. Unchanged from the original list view,
 *  now scoped to the Servers tab. */
function EmptyState({ onAdd }: { onAdd: () => void }) {
  const { t } = useI18n();
  return (
    <div className="py-16 text-center">
      <div className="relative mx-auto w-64 h-44 mb-8">
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 260 180" fill="none">
          {/* Stacked server card */}
          <rect x="58" y="52" width="116" height="88" rx="14" fill="var(--th-sf-04)" />
          <rect x="48" y="42" width="116" height="88" rx="14" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
          <rect x="38" y="32" width="116" height="88" rx="14" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />
          {/* Rack units — one online (single success accent), the rest idle */}
          <rect x="52" y="46" width="74" height="16" rx="4" fill="var(--th-on-05)" stroke="var(--th-on-10)" strokeWidth="0.8" />
          <rect x="58" y="52" width="38" height="4" rx="2" fill="var(--th-on-12)" />
          <circle cx="138" cy="54" r="3" fill="#22c55e" fillOpacity="0.7" />
          <rect x="52" y="68" width="74" height="16" rx="4" fill="var(--th-on-04)" stroke="var(--th-on-08)" strokeWidth="0.8" />
          <rect x="58" y="74" width="38" height="4" rx="2" fill="var(--th-on-10)" />
          <circle cx="138" cy="76" r="3" fill="var(--th-on-16)" />
          <rect x="52" y="90" width="74" height="16" rx="4" fill="var(--th-on-04)" stroke="var(--th-on-08)" strokeWidth="0.8" />
          <rect x="58" y="96" width="38" height="4" rx="2" fill="var(--th-on-08)" />
          <circle cx="138" cy="98" r="3" fill="var(--th-on-12)" />
          {/* Dashed connector → add node */}
          <path d="M154 86 Q 176 84 188 86" stroke="var(--th-on-16)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />
          {/* Add-server node */}
          <circle cx="210" cy="86" r="22" fill="var(--th-on-05)" />
          <circle cx="210" cy="86" r="16" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
          <path d="M210 78v16M202 86h16" stroke="var(--th-on-40)" strokeWidth="2" strokeLinecap="round" />
          {/* Decorative dots + sparkles */}
          <circle cx="26" cy="58" r="4" fill="var(--th-on-10)" />
          <circle cx="34" cy="146" r="6" fill="var(--th-on-06)" />
          <circle cx="238" cy="40" r="3.5" fill="var(--th-on-12)" />
          <circle cx="248" cy="132" r="4.5" fill="var(--th-on-06)" />
          <path d="M22 104l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
          <path d="M228 150l1.6-3.2 1.6 3.2-3.2-1.6 3.2 0-3.2 1.6z" fill="var(--th-on-12)" />
        </svg>
      </div>

      <h3 className="text-2xl font-medium text-foreground/80 mb-2" style={{ letterSpacing: "-0.2px" }}>
        {t.servers.list.emptyTitle}
      </h3>
      <p className="text-sm text-muted-foreground/70 max-w-sm mx-auto mb-8 leading-relaxed">
        {t.servers.list.emptyDescription}
      </p>

      <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-10">
        <button
          onClick={onAdd}
          className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
        >
          <Plus className="size-4" />
          {t.servers.list.addFirstServer}
        </button>
        <a
          href="https://openship.io/docs/self-hosting"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-xl bg-muted/50 px-6 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
        >
          <BookOpen className="size-4" />
          {t.servers.list.seeDocs}
          <ExternalLink className="size-3.5 opacity-60" />
        </a>
      </div>

      <div className="max-w-2xl mx-auto">
        <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-4">
          {t.servers.list.whatGetsConfigured}
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: t.servers.list.featContainer, desc: t.servers.list.featContainerDesc, Icon: Container },
            { label: t.servers.list.featProxy, desc: t.servers.list.featProxyDesc, Icon: Globe },
            { label: t.servers.list.monitoring, desc: t.servers.list.monitoringDesc, Icon: Activity },
            { label: "Git", desc: t.servers.list.gitDesc, Icon: GitBranch },
          ].map((f) => (
            <div key={f.label} className="bg-card border border-border/50 rounded-xl p-4 text-start">
              <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
                <f.Icon className="size-4 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium text-foreground">{f.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
