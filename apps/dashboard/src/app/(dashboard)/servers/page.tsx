"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Server,
  Plus,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Wifi,
  Shield,
} from "lucide-react";
import { systemApi } from "@/lib/api";

interface ServerEntry {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  status: "connected" | "error" | "unknown";
}

export default function ServersPage() {
  const router = useRouter();
  const [servers, setServers] = useState<ServerEntry[]>([]);
  const [loading, setLoading] = useState(true);

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
          status: "connected" as const,
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

  return (
    <div className="min-h-screen bg-background">
      <div className="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1
              className="text-2xl font-medium text-foreground/80"
              style={{ letterSpacing: "-0.2px" }}
            >
              Servers
            </h1>
            <p className="text-sm text-muted-foreground/70 mt-1">
              Manage your deployment servers and infrastructure
            </p>
          </div>
          <button
            onClick={() => router.push("/servers/new")}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25"
          >
            <Plus className="size-4" />
            Add Server
          </button>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6">
          {/* ── LEFT COLUMN ── */}
          <div className="space-y-6 min-w-0">
            {loading ? (
              <div className="flex items-center justify-center py-20">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : servers.length === 0 ? (
              <div className="py-16 text-center">
                {/* SVG Illustration — server themed */}
                <div className="relative mx-auto w-64 h-44 mb-8">
                  <svg className="absolute inset-0 w-full h-full" viewBox="0 0 260 180" fill="none">
                    {/* Server rack stack */}
                    <rect x="60" y="50" width="120" height="90" rx="14" fill="var(--th-sf-04)" />
                    <rect x="50" y="40" width="120" height="90" rx="14" fill="var(--th-sf-03)" stroke="var(--th-bd-subtle)" strokeWidth="1" />
                    <rect x="40" y="30" width="120" height="90" rx="14" fill="var(--th-card-bg)" stroke="var(--th-bd-default)" strokeWidth="1" />

                    {/* Server unit lines */}
                    <rect x="55" y="46" width="90" height="6" rx="3" fill="var(--th-on-08)" />
                    <circle cx="152" cy="49" r="3" fill="#22c55e" fillOpacity="0.6" />
                    <rect x="55" y="60" width="90" height="6" rx="3" fill="var(--th-on-08)" />
                    <circle cx="152" cy="63" r="3" fill="#22c55e" fillOpacity="0.6" />
                    <rect x="55" y="74" width="90" height="6" rx="3" fill="var(--th-on-08)" />
                    <circle cx="152" cy="77" r="3" fill="var(--th-on-12)" />

                    {/* Terminal icon */}
                    <rect x="55" y="92" width="42" height="22" rx="5" fill="var(--th-on-05)" stroke="var(--th-on-10)" strokeWidth="1" />
                    <path d="M63 98l5 4-5 4" stroke="var(--th-on-30)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    <rect x="72" y="105" width="16" height="2" rx="1" fill="var(--th-on-16)" />

                    {/* Plus circle */}
                    <circle cx="210" cy="85" r="22" fill="var(--th-on-05)" />
                    <circle cx="210" cy="85" r="16" fill="var(--th-card-bg)" stroke="var(--th-on-20)" strokeWidth="2" strokeDasharray="4 3" />
                    <path d="M210 77v16M202 85h16" stroke="var(--th-on-40)" strokeWidth="2" strokeLinecap="round" />

                    {/* Decorative dots */}
                    <circle cx="25" cy="55" r="4" fill="var(--th-on-10)" />
                    <circle cx="35" cy="145" r="6" fill="var(--th-on-08)" />
                    <circle cx="235" cy="38" r="3" fill="var(--th-on-12)" />
                    <circle cx="248" cy="130" r="5" fill="var(--th-on-06)" />

                    {/* Sparkle accents */}
                    <path d="M20 105l2-4 2 4-4-2 4 0-4 2z" fill="var(--th-on-16)" />
                    <path d="M225 150l1.5-3 1.5 3-3-1.5 3 0-3 1.5z" fill="var(--th-on-12)" />

                    {/* Connecting dashed line */}
                    <path d="M170 85 Q 185 82 195 85" stroke="var(--th-on-12)" strokeWidth="1.5" strokeDasharray="3 3" fill="none" />
                  </svg>
                </div>

                <h3 className="text-2xl font-medium text-foreground/80 mb-2" style={{ letterSpacing: "-0.2px" }}>
                  No servers yet
                </h3>
                <p className="text-sm text-muted-foreground/70 max-w-sm mx-auto mb-8 leading-relaxed">
                  Connect a server via SSH and Openship will handle the rest —
                  Docker, Nginx, SSL, and deployments all set up automatically.
                </p>

                <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-10">
                  <button
                    onClick={() => router.push("/servers/new")}
                    className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
                  >
                    <Plus className="size-4" />
                    Add Your First Server
                  </button>
                </div>

                {/* Feature highlight cards */}
                <div className="max-w-2xl mx-auto">
                  <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-4">
                    What gets configured
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <div className="bg-card border border-border/50 rounded-xl p-4 text-left">
                      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
                        <Server className="size-4 text-muted-foreground" />
                      </div>
                      <p className="text-sm font-medium text-foreground">Docker</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Container runtime</p>
                    </div>
                    <div className="bg-card border border-border/50 rounded-xl p-4 text-left">
                      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
                        <Shield className="size-4 text-muted-foreground" />
                      </div>
                      <p className="text-sm font-medium text-foreground">Nginx</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Reverse proxy & SSL</p>
                    </div>
                    <div className="bg-card border border-border/50 rounded-xl p-4 text-left">
                      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
                        <Wifi className="size-4 text-muted-foreground" />
                      </div>
                      <p className="text-sm font-medium text-foreground">Monitoring</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Health checks</p>
                    </div>
                    <div className="bg-card border border-border/50 rounded-xl p-4 text-left">
                      <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center mb-3">
                        <ExternalLink className="size-4 text-muted-foreground" />
                      </div>
                      <p className="text-sm font-medium text-foreground">Git</p>
                      <p className="text-xs text-muted-foreground mt-0.5">Source deployments</p>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                {servers.map((server) => (
                  <button
                    key={server.id}
                    onClick={() => router.push(`/servers/${server.id}`)}
                    className="w-full text-left bg-card rounded-2xl border border-border/50 p-5 hover:border-border transition-colors group"
                  >
                    <div className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center shrink-0">
                        <Server className="size-5 text-blue-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium text-foreground truncate">
                            {server.name}
                          </p>
                          {server.status === "connected" ? (
                            <div className="inline-flex items-center gap-1 px-2 py-0.5 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-medium rounded-full">
                              <CheckCircle2 className="size-3" />
                              Connected
                            </div>
                          ) : (
                            <div className="inline-flex items-center gap-1 px-2 py-0.5 bg-red-500/10 text-red-600 dark:text-red-400 text-xs font-medium rounded-full">
                              <XCircle className="size-3" />
                              Error
                            </div>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {server.user}@{server.host}:{server.port}
                        </p>
                      </div>
                      <ExternalLink className="size-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* ── RIGHT COLUMN (Sticky) ── */}
          <div className="space-y-4 lg:sticky lg:top-6 lg:self-start">
            <div className="bg-card rounded-2xl border border-border/50">
              <div className="flex items-center gap-3 px-5 py-4 border-b border-border/50">
                <div className="w-9 h-9 bg-emerald-500/10 rounded-xl flex items-center justify-center">
                  <Shield className="size-[18px] text-emerald-500" />
                </div>
                <div>
                  <h2 className="font-semibold text-foreground text-[15px]">Quick Info</h2>
                  <p className="text-xs text-muted-foreground">Server overview</p>
                </div>
              </div>
              <div className="p-5">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Total Servers</span>
                    <span className="text-sm font-medium text-foreground">
                      {loading ? "…" : servers.length}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Connected</span>
                    <span className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
                      {loading ? "…" : servers.filter((s) => s.status === "connected").length}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted-foreground">Errors</span>
                    <span className="text-sm font-medium text-red-600 dark:text-red-400">
                      {loading ? "…" : servers.filter((s) => s.status === "error").length}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
