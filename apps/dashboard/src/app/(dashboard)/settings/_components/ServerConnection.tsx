"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import {
  Server,
  Loader2,
  Check,
  KeyRound,
  Lock,
  ChevronDown,
  Pencil,
  X,
} from "lucide-react";
import { getApiErrorMessage, systemApi } from "@/lib/api";
import type { ServerInfo } from "@/lib/api/system";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";


/* ── Component ──────────────────────────────────────────────────── */

export function ServerConnection() {
  const router = useRouter();
  const { showToast } = useToast();
  const [server, setServer] = useState<ServerInfo | null>(null);
  const [serverCount, setServerCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  /* ── Form state ── */
  const [sshHost, setSshHost] = useState("");
  const [sshPort, setSshPort] = useState("22");
  const [sshUser, setSshUser] = useState("root");
  const [sshAuthMethod, setSshAuthMethod] = useState<"password" | "key">("password");
  const [sshPassword, setSshPassword] = useState("");
  const [sshKeyPath, setSshKeyPath] = useState("");
  const [sshKeyPassphrase, setSshKeyPassphrase] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const fetchSettings = useCallback(async () => {
    try {
      setLoading(true);
      const servers = await systemApi.listServers();
      setServerCount(servers.length);
      if (servers.length === 1) {
        setServer(servers[0]);
        const s = servers[0];
        setSshHost(s.sshHost ?? "");
        setSshPort(String(s.sshPort ?? 22));
        setSshUser(s.sshUser ?? "root");
        setSshAuthMethod(s.sshAuthMethod === "key" ? "key" : "password");
      } else {
        setServer(null);
      }
    } catch {
      /* silent — may not be available in cloud mode */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  function startEdit() {
    setEditing(true);
    // Reset secret fields — user must re-enter
    setSshPassword("");
    setSshKeyPath("");
    setSshKeyPassphrase("");
  }

  function cancelEdit() {
    setEditing(false);
    // Restore from server
    if (server) {
      setSshHost(server.sshHost ?? "");
      setSshPort(String(server.sshPort ?? 22));
      setSshUser(server.sshUser ?? "root");
      setSshAuthMethod(server.sshAuthMethod === "key" ? "key" : "password");
    }
  }

  async function handleSave() {
    if (!sshHost.trim()) {
      showToast("Server host is required", "error", "Settings");
      return;
    }

    setSaving(true);
    try {
      const data: Record<string, unknown> = {
        sshHost: sshHost.trim(),
        sshPort: parseInt(sshPort, 10) || 22,
        sshUser: sshUser.trim() || "root",
        sshAuthMethod,
      };

      // Only send secrets if user provided them
      if (sshAuthMethod === "password" && sshPassword) {
        data.sshPassword = sshPassword;
      }
      if (sshAuthMethod === "key" && sshKeyPath) {
        data.sshKeyPath = sshKeyPath;
        if (sshKeyPassphrase) data.sshKeyPassphrase = sshKeyPassphrase;
      }

      if (server) {
        await systemApi.updateServerEntry(server.id, data);
      } else {
        await systemApi.createServerEntry(data);
      }
      showToast("Server settings updated", "success", "Settings");
      setEditing(false);
      fetchSettings();
    } catch (err) {
      showToast(
        getApiErrorMessage(err, "Failed to update server settings"),
        "error",
        "Settings",
      );
    } finally {
      setSaving(false);
    }
  }

  const configured = !!server;
  const hasMultipleServers = serverCount > 1;
  const description = loading
    ? "Loading…"
    : hasMultipleServers
      ? `${serverCount} servers configured`
    : configured
      ? server.sshHost ?? "Configured"
      : "Not configured";

  return (
    <SettingsSection
      icon={Server}
      title="Server Connection"
      iconBg="bg-blue-500/10"
      iconColor="text-blue-500"
      description={description}
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="size-4 animate-spin" />
          Loading server settings…
        </div>
      ) : hasMultipleServers ? (
        <div className="rounded-xl border border-border/50 p-4 bg-muted/20">
          <p className="text-sm text-foreground mb-2">
            Server connections are managed in the Servers section.
          </p>
          <p className="text-xs text-muted-foreground mb-4">
            This settings panel only supports the legacy single-server shortcut. You have {serverCount} configured servers.
          </p>
          <button
            onClick={() => router.push("/servers")}
            className="inline-flex items-center gap-2 px-4 py-2 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
          >
            <Server className="size-4" />
            Open Servers
          </button>
        </div>
      ) : !editing ? (
        /* ── Read-only view ── */
        <>
          {configured ? (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* SSH Host */}
                <div className="flex items-center gap-3 rounded-xl border border-border/50 p-4">
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
                    <Server className="size-4 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {server.sshHost}:{server.sshPort ?? 22}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {server.sshUser ?? "root"}@host
                    </p>
                  </div>
                </div>

                {/* Auth method */}
                <div className="flex items-center gap-3 rounded-xl border border-border/50 p-4">
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center">
                    {server.sshAuthMethod === "key" ? (
                      <KeyRound className="size-4 text-muted-foreground" />
                    ) : (
                      <Lock className="size-4 text-muted-foreground" />
                    )}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">
                      {server.sshAuthMethod === "key" ? "SSH Key" : "Password"}
                    </p>
                    <p className="text-xs text-muted-foreground">Authentication method</p>
                  </div>
                </div>
              </div>

              <button
                onClick={startEdit}
                className="inline-flex items-center gap-2 px-4 py-2 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors mt-1"
              >
                <Pencil className="size-3.5" />
                Edit Connection
              </button>
            </div>
          ) : (
            <div className="text-center py-4">
              <p className="text-sm text-muted-foreground mb-4">
                No server connection configured. Set up SSH access to deploy to a remote server.
              </p>
              <button
                onClick={startEdit}
                className="inline-flex items-center gap-2 px-6 py-3 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 hover:-translate-y-0.5"
              >
                <Server className="size-4" />
                Configure Server
              </button>
            </div>
          )}
        </>
      ) : (
        /* ── Edit form ── */
        <div className="space-y-4">
          {/* SSH Host + Port */}
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_120px] gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Server Host
              </label>
              <input
                type="text"
                value={sshHost}
                onChange={(e) => setSshHost(e.target.value)}
                placeholder="192.168.1.100 or example.com"
                className="w-full h-10 px-3 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
                Port
              </label>
              <input
                type="number"
                value={sshPort}
                onChange={(e) => setSshPort(e.target.value)}
                placeholder="22"
                className="w-full h-10 px-3 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50"
              />
            </div>
          </div>

          {/* Username */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Username
            </label>
            <input
              type="text"
              value={sshUser}
              onChange={(e) => setSshUser(e.target.value)}
              placeholder="root"
              className="w-full h-10 px-3 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50"
            />
          </div>

          {/* Auth method tabs */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1.5 block">
              Authentication
            </label>
            <div className="flex rounded-lg border border-border overflow-hidden mb-3">
              <button
                type="button"
                onClick={() => setSshAuthMethod("password")}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm transition-colors ${
                  sshAuthMethod === "password"
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-muted/50"
                }`}
              >
                <Lock className="size-3.5" />
                Password
              </button>
              <button
                type="button"
                onClick={() => setSshAuthMethod("key")}
                className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 text-sm border-l border-border transition-colors ${
                  sshAuthMethod === "key"
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-muted/50"
                }`}
              >
                <KeyRound className="size-3.5" />
                SSH Key
              </button>
            </div>

            {sshAuthMethod === "password" ? (
              <input
                type="password"
                value={sshPassword}
                onChange={(e) => setSshPassword(e.target.value)}
                placeholder="Enter password (leave empty to keep current)"
                className="w-full h-10 px-3 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50"
              />
            ) : (
              <div className="space-y-3">
                <input
                  type="text"
                  value={sshKeyPath}
                  onChange={(e) => setSshKeyPath(e.target.value)}
                  placeholder="Path to SSH key (e.g. ~/.ssh/id_rsa)"
                  className="w-full h-10 px-3 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50"
                />
                <input
                  type="password"
                  value={sshKeyPassphrase}
                  onChange={(e) => setSshKeyPassphrase(e.target.value)}
                  placeholder="Key passphrase (optional)"
                  className="w-full h-10 px-3 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary/50"
                />
              </div>
            )}
          </div>

          {/* Advanced toggle (placeholder for jumpHost, sshArgs) */}
          <button
            type="button"
            onClick={() => setShowAdvanced(!showAdvanced)}
            className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
          >
            <ChevronDown className={`size-3 transition-transform ${showAdvanced ? "rotate-180" : ""}`} />
            Advanced options
          </button>

          {showAdvanced && (
            <p className="text-xs text-muted-foreground bg-muted/50 rounded-lg p-3">
              Jump host and extra SSH args can be configured during onboarding
              or via the CLI. Support for editing these here is coming soon.
            </p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <button
              onClick={handleSave}
              disabled={saving || !sshHost.trim()}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all disabled:opacity-50"
            >
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
              Save
            </button>
            <button
              onClick={cancelEdit}
              className="inline-flex items-center gap-2 px-5 py-2.5 bg-muted/50 text-foreground text-sm font-medium rounded-xl hover:bg-muted transition-colors"
            >
              <X className="size-4" />
              Cancel
            </button>
          </div>
        </div>
      )}
    </SettingsSection>
  );
}
