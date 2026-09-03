"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Globe,
  Plus,
  Trash2,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ShieldCheck,
  Star,
  ExternalLink,
  Sparkles,
} from "lucide-react";
import { domainsApi, type WildcardDomainItem, type DashboardDomainInfo } from "@/lib/api/domains";
import { dnsApi, type SanitizedDnsCredential } from "@/lib/api/dns";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";

export function DomainsSettingsTab() {
  const { showToast } = useToast();

  // Dashboard Domain state
  const [dashboardInfo, setDashboardInfo] = useState<DashboardDomainInfo | null>(null);
  const [dashboardDomainInput, setDashboardDomainInput] = useState("");
  const [dashboardAutoDns, setDashboardAutoDns] = useState(true);
  const [savingDashboard, setSavingDashboard] = useState(false);

  // Wildcard Domains state
  const [wildcards, setWildcards] = useState<WildcardDomainItem[]>([]);
  const [loadingWildcards, setLoadingWildcards] = useState(true);
  const [newWildcardInput, setNewWildcardInput] = useState("");
  const [newWildcardIsDefault, setNewWildcardIsDefault] = useState(true);
  const [newWildcardAutoDns, setNewWildcardAutoDns] = useState(true);
  const [addingWildcard, setAddingWildcard] = useState(false);
  const [busyWildcardId, setBusyWildcardId] = useState<string | null>(null);

  // DNS Credentials state
  const [dnsCreds, setDnsCreds] = useState<SanitizedDnsCredential[]>([]);
  const [selectedCredId, setSelectedCredId] = useState<string>("");
  const [zones, setZones] = useState<Array<{ id: string; name: string }>>([]);

  const loadData = useCallback(async () => {
    try {
      setLoadingWildcards(true);
      const [wildcardRes, dashRes, credsRes] = await Promise.all([
        domainsApi.listWildcards().catch(() => ({ data: [] })),
        domainsApi.getDashboardDomain().catch(() => ({ data: null })),
        dnsApi.listCredentials().catch(() => ({ data: [] })),
      ]);

      setWildcards(wildcardRes.data || []);
      if (dashRes.data) {
        setDashboardInfo(dashRes.data);
        if (dashRes.data.dashboardDomain) {
          setDashboardDomainInput(dashRes.data.dashboardDomain);
        }
      }

      const creds = credsRes.data || [];
      setDnsCreds(creds);
      const cfCred = creds.find((c) => c.provider === "cloudflare");
      if (cfCred) {
        setSelectedCredId(cfCred.id);
        dnsApi
          .listZones(cfCred.id)
          .then((res) => setZones(res.data || []))
          .catch(() => {});
      }
    } catch {
      showToast("Failed to load domain settings", "error");
    } finally {
      setLoadingWildcards(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSaveDashboardDomain = async () => {
    if (!dashboardDomainInput.trim()) {
      showToast("Please enter a domain", "error");
      return;
    }
    setSavingDashboard(true);
    try {
      const res = await domainsApi.setDashboardDomain({
        domain: dashboardDomainInput.trim(),
        autoDns: dashboardAutoDns,
        dnsCredentialId: selectedCredId || undefined,
      });
      setDashboardInfo(res.data);
      showToast("Dashboard domain saved successfully", "success");
    } catch {
      showToast("Failed to save dashboard domain", "error");
    } finally {
      setSavingDashboard(false);
    }
  };

  const handleDeleteDashboardDomain = async () => {
    setSavingDashboard(true);
    try {
      await domainsApi.deleteDashboardDomain();
      setDashboardInfo(null);
      setDashboardDomainInput("");
      showToast("Dashboard domain removed", "success");
    } catch {
      showToast("Failed to remove dashboard domain", "error");
    } finally {
      setSavingDashboard(false);
    }
  };

  const handleAddWildcard = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWildcardInput.trim()) {
      showToast("Please enter a wildcard domain", "error");
      return;
    }
    setAddingWildcard(true);
    try {
      await domainsApi.addWildcard({
        domain: newWildcardInput.trim(),
        isDefault: newWildcardIsDefault,
        autoDns: newWildcardAutoDns,
        dnsCredentialId: selectedCredId || undefined,
      });
      setNewWildcardInput("");
      showToast("Wildcard domain added successfully", "success");
      await loadData();
    } catch {
      showToast("Failed to add wildcard domain", "error");
    } finally {
      setAddingWildcard(false);
    }
  };

  const handleSetDefaultWildcard = async (id: string) => {
    setBusyWildcardId(id);
    try {
      await domainsApi.setDefaultWildcard(id);
      showToast("Default wildcard domain updated", "success");
      await loadData();
    } catch {
      showToast("Failed to update default wildcard", "error");
    } finally {
      setBusyWildcardId(null);
    }
  };

  const handleDeleteWildcard = async (id: string) => {
    setBusyWildcardId(id);
    try {
      await domainsApi.deleteWildcard(id);
      showToast("Wildcard domain deleted", "success");
      await loadData();
    } catch {
      showToast("Failed to delete wildcard domain", "error");
    } finally {
      setBusyWildcardId(null);
    }
  };

  const hasCloudflare = dnsCreds.some((c) => c.provider === "cloudflare");

  return (
    <div className="space-y-6">
      {/* ─── Dashboard Root Domain Section ───────────────────────────────────── */}
      <SettingsSection
        icon={Globe}
        title="Dashboard Root Domain"
        description="Assign a custom domain for accessing this OpenShip control plane (e.g. dashboard.example.com)."
      >
        <div className="p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <input
              type="text"
              placeholder="e.g. dashboard.mycompany.com"
              value={dashboardDomainInput}
              onChange={(e) => setDashboardDomainInput(e.target.value)}
              className="flex-1 px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleSaveDashboardDomain}
                disabled={savingDashboard}
                className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2 shrink-0"
              >
                {savingDashboard && <Loader2 className="size-4 animate-spin" />}
                Save Domain
              </button>
              {dashboardInfo?.dashboardDomain && (
                <button
                  type="button"
                  onClick={handleDeleteDashboardDomain}
                  disabled={savingDashboard}
                  className="px-3 py-2 text-destructive hover:bg-destructive/10 text-sm font-medium rounded-xl transition-colors shrink-0"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
          </div>

          {hasCloudflare && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={dashboardAutoDns}
                onChange={(e) => setDashboardAutoDns(e.target.checked)}
                className="rounded border-border"
              />
              <span>Auto-create DNS A-record in Cloudflare pointing to this server</span>
            </label>
          )}

          {dashboardInfo?.dashboardDomain && (
            <div className="flex items-center gap-3 p-3 bg-muted/40 rounded-xl text-xs">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <CheckCircle2 className="size-3.5 text-emerald-500" />
                <span>Active Domain:</span>
                <span className="font-mono">{dashboardInfo.dashboardDomain}</span>
              </div>
              <span className="text-muted-foreground">•</span>
              <span className="text-muted-foreground">
                SSL:{" "}
                <span className="font-medium capitalize text-foreground">
                  {dashboardInfo.dashboardSslStatus}
                </span>
              </span>
            </div>
          )}
        </div>
      </SettingsSection>

      {/* ─── Wildcard App Domains Section ────────────────────────────────────── */}
      <SettingsSection
        icon={Sparkles}
        title="Wildcard App Domains"
        description="Configure wildcard domains (*.apps.example.com). New projects automatically receive a unique collision-proof subdomain."
      >
        <div className="p-6 space-y-6">
          {/* Add Wildcard Form */}
          <form onSubmit={handleAddWildcard} className="space-y-3 p-4 bg-muted/30 border border-border/50 rounded-xl">
            <div className="text-sm font-medium text-foreground">Add New Wildcard Domain</div>
            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <input
                type="text"
                placeholder="e.g. *.apps.mycompany.com"
                value={newWildcardInput}
                onChange={(e) => setNewWildcardInput(e.target.value)}
                className="flex-1 px-3 py-2 bg-background border border-border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-primary/20"
              />
              <button
                type="submit"
                disabled={addingWildcard}
                className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-colors disabled:opacity-50 flex items-center gap-2 shrink-0"
              >
                {addingWildcard ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
                Add Wildcard
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground pt-1">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newWildcardIsDefault}
                  onChange={(e) => setNewWildcardIsDefault(e.target.checked)}
                  className="rounded border-border"
                />
                <span>Set as default for new projects</span>
              </label>

              {hasCloudflare && (
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={newWildcardAutoDns}
                    onChange={(e) => setNewWildcardAutoDns(e.target.checked)}
                    className="rounded border-border"
                  />
                  <span>Auto-create wildcard A-record in Cloudflare</span>
                </label>
              )}
            </div>
          </form>

          {/* List of Wildcards */}
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Configured Wildcard Domains ({wildcards.length})
            </div>

            {loadingWildcards ? (
              <div className="p-6 text-center text-muted-foreground text-sm flex items-center justify-center gap-2">
                <Loader2 className="size-4 animate-spin" /> Loading wildcard domains...
              </div>
            ) : wildcards.length === 0 ? (
              <div className="p-6 text-center text-muted-foreground text-sm border border-dashed border-border rounded-xl">
                No wildcard domains configured. Add one above to enable automatic project subdomains.
              </div>
            ) : (
              <div className="divide-y divide-border/50 border border-border/50 rounded-xl overflow-hidden bg-card">
                {wildcards.map((wc) => (
                  <div key={wc.id} className="p-4 flex items-center justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm font-medium text-foreground">
                          {wc.domain}
                        </span>
                        {wc.isDefault && (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400">
                            <Star className="size-3 fill-current" /> Default
                          </span>
                        )}
                        {wc.dnsProvider === "cloudflare" && (
                          <span className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400">
                            Cloudflare Auto-DNS
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Apex: <span className="font-mono">{wc.apex}</span> • Auto-generates:{" "}
                        <span className="font-mono">[project]-[hash].{wc.apex}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      {!wc.isDefault && (
                        <button
                          type="button"
                          onClick={() => handleSetDefaultWildcard(wc.id)}
                          disabled={busyWildcardId === wc.id}
                          className="px-2.5 py-1 text-xs border border-border rounded-lg hover:bg-muted font-medium transition-colors"
                        >
                          Make Default
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleDeleteWildcard(wc.id)}
                        disabled={busyWildcardId === wc.id}
                        className="p-1.5 text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
