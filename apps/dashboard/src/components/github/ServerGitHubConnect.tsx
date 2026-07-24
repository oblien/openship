"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Github,
  KeyRound,
  Terminal,
  Copy,
  Check,
  Loader2,
  ExternalLink,
  Trash2,
} from "lucide-react";
import {
  serverGithubApi,
  getApiErrorMessage,
  type ServerGithubStatus,
  type ServerGithubMode,
} from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useModal } from "@/context/ModalContext";
import { useI18n } from "@/components/i18n-provider";

/**
 * The ONE per-server GitHub connect model (self-hosted). How THIS server
 * authenticates to GitHub to clone private repos — device-login token, pasted
 * PAT, an SSH server key, or per-repo deploy keys. Wins over the account /
 * App / relay chain for clones that run on this server.
 *
 * Reused verbatim in three places so the flow never forks:
 *   - the server detail "GitHub" tab (`variant="card"`),
 *   - the deploy credential modal's "Connect GitHub on this server" option,
 *   - any "connect GitHub" empty state,
 * the latter two via {@link useServerGitHubConnectModal}.
 *
 * `onConnected` fires when the server transitions to a usable credential
 * (device / PAT / deploy-key). SSH server-key generation does NOT fire it — the
 * public key still has to be added to the GitHub account first.
 */
export function ServerGitHubConnect({
  serverId,
  variant = "card",
  onConnected,
}: {
  serverId: string;
  variant?: "card" | "bare";
  onConnected?: () => void;
}) {
  const { t } = useI18n();
  const g = t.servers.github;
  const { showToast } = useToast();

  const [status, setStatus] = useState<ServerGithubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<ServerGithubMode>("token");
  const [pat, setPat] = useState("");
  const [device, setDevice] = useState<{ userCode: string; uri: string } | null>(null);
  const [sshPublic, setSshPublic] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      const s = await serverGithubApi.get(serverId);
      setStatus(s);
      if (s.mode) setTab(s.mode);
      if (s.serverKeyPublic) setSshPublic(s.serverKeyPublic);
    } catch (err) {
      showToast(getApiErrorMessage(err, g.loadFailed), "error", g.title);
    } finally {
      setLoading(false);
    }
  }, [serverId, showToast, g.loadFailed, g.title]);

  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [load]);

  const startDevice = async () => {
    setBusy(true);
    try {
      const res = await serverGithubApi.connect(serverId);
      setDevice({ userCode: res.userCode, uri: res.verificationUri });
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(
        async () => {
          const r = await serverGithubApi.connectPoll(serverId).catch(() => null);
          const st = r?.data;
          if (st?.status === "complete") {
            if (pollRef.current) clearInterval(pollRef.current);
            setDevice(null);
            showToast(g.connectedToast, "success", g.title);
            await load();
            onConnected?.();
          } else if (st?.status === "error") {
            if (pollRef.current) clearInterval(pollRef.current);
            setDevice(null);
            showToast(st.error ?? g.connectFailed, "error", g.title);
          }
        },
        (res.interval || 5) * 1000,
      );
    } catch (err) {
      showToast(getApiErrorMessage(err, g.connectFailed), "error", g.title);
    } finally {
      setBusy(false);
    }
  };

  const savePat = async () => {
    if (!pat.trim()) return;
    setBusy(true);
    try {
      await serverGithubApi.setToken(serverId, pat.trim());
      setPat("");
      showToast(g.savedToast, "success", g.title);
      await load();
      onConnected?.();
    } catch (err) {
      showToast(getApiErrorMessage(err, g.saveFailed), "error", g.title);
    } finally {
      setBusy(false);
    }
  };

  const genKey = async () => {
    setBusy(true);
    try {
      const res = await serverGithubApi.generateSshKey(serverId);
      setSshPublic(res.publicKey);
      await load();
      // No onConnected — the operator still has to add this public key to the
      // GitHub account before a clone can succeed.
    } catch (err) {
      showToast(getApiErrorMessage(err, g.saveFailed), "error", g.title);
    } finally {
      setBusy(false);
    }
  };

  const useDeployKeys = async () => {
    setBusy(true);
    try {
      await serverGithubApi.useDeployKeyMode(serverId);
      showToast(g.savedToast, "success", g.title);
      await load();
      onConnected?.();
    } catch (err) {
      showToast(getApiErrorMessage(err, g.saveFailed), "error", g.title);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    try {
      await serverGithubApi.disconnect(serverId);
      setSshPublic(null);
      showToast(g.disconnectedToast, "success", g.title);
      await load();
    } catch (err) {
      showToast(getApiErrorMessage(err, g.saveFailed), "error", g.title);
    } finally {
      setBusy(false);
    }
  };

  const copyKey = async () => {
    if (!sshPublic) return;
    await navigator.clipboard.writeText(sshPublic).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const TABS: Array<{ id: ServerGithubMode; label: string; icon: typeof Github }> = [
    { id: "token", label: g.modeToken, icon: Github },
    { id: "ssh-server-key", label: g.modeSshKey, icon: KeyRound },
    { id: "ssh-deploy-key", label: g.modeDeployKey, icon: Terminal },
  ];

  // Card variant mirrors the server "Security" tab: a titled header with an
  // icon chip, split by a divider from a padded body. Bare variant (the deploy
  // modal) stays chrome-less.
  const isCard = variant === "card";

  return (
    <div className={isCard ? "w-full rounded-2xl border border-border/50 bg-card" : ""}>
      <div
        className={
          isCard
            ? "flex items-center justify-between gap-3 px-5 py-4 border-b border-border/50"
            : "flex items-center justify-between gap-4"
        }
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="flex w-9 h-9 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.06]">
            <Github className="size-[18px] text-foreground/80" />
          </div>
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-foreground">{g.title}</h2>
            <p className="text-xs text-muted-foreground">{g.desc}</p>
          </div>
        </div>
        {status?.connected && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success-bg px-2 py-0.5 text-xs font-medium text-success">
            <Check className="size-3" /> {g.connected}
          </span>
        )}
      </div>

      <div className={isCard ? "p-5" : "mt-4"}>
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            {/* Mode switch */}
            <div className="flex flex-wrap gap-1.5">
              {TABS.map(({ id, label, icon: Icon }) => {
                const on = tab === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[13px] font-medium transition-colors ${
                      on
                        ? "border-primary/40 bg-primary/[0.06] text-foreground"
                        : "border-border/60 text-muted-foreground hover:bg-muted/40"
                    }`}
                  >
                    <Icon className={`size-3.5 ${on ? "text-primary" : ""}`} /> {label}
                  </button>
                );
              })}
            </div>

            {/* Active mode's flow in its own container — mirrors the Security
                tab's inner sub-cards for a cleaner grouped look. */}
            <div className="mt-4 rounded-xl border border-border/50 bg-muted/20 p-4">
              {tab === "token" && (
                <div className="space-y-3">
                  {status?.mode === "token" && status.tokenLogin && (
                    <p className="text-[13px] text-muted-foreground">
                      {g.tokenAs}{" "}
                      <span className="font-medium text-foreground">{status.tokenLogin}</span>
                      {status.tokenSource ? ` · ${status.tokenSource}` : ""}
                    </p>
                  )}
                  {device ? (
                    <div className="rounded-xl border border-border/50 bg-muted/30 p-4 text-center">
                      <p className="text-[13px] text-muted-foreground">{g.deviceHint}</p>
                      <p className="my-2 font-mono text-lg font-semibold tracking-widest text-foreground">
                        {device.userCode}
                      </p>
                      <a
                        href={device.uri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        {g.open} <ExternalLink className="size-3.5" />
                      </a>
                      <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" /> {g.connecting}
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <button
                        type="button"
                        onClick={startDevice}
                        disabled={busy}
                        className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-foreground px-4 py-2.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        <Github className="size-4" /> {g.connectDevice}
                      </button>

                      <div className="flex items-center gap-3">
                        <span className="h-px flex-1 bg-border/50" />
                        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                          {g.or}
                        </span>
                        <span className="h-px flex-1 bg-border/50" />
                      </div>

                      <div>
                        <label className="mb-1.5 block text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
                          {g.patLabel}
                        </label>
                        <div className="flex items-center gap-1.5 rounded-xl border border-border bg-card py-1 pe-1.5 ps-3 transition-colors focus-within:ring-2 focus-within:ring-primary/25">
                          <input
                            type="password"
                            value={pat}
                            onChange={(e) => setPat(e.target.value)}
                            placeholder={g.patPlaceholder}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" && pat.trim()) {
                                e.preventDefault();
                                void savePat();
                              }
                            }}
                            className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none"
                          />
                          <button
                            type="button"
                            onClick={savePat}
                            disabled={busy || !pat.trim()}
                            className="shrink-0 rounded-lg bg-foreground px-3 py-1.5 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {g.save}
                          </button>
                        </div>
                        <p className="mt-1.5 text-xs text-muted-foreground/70">{g.patHint}</p>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {tab === "ssh-server-key" && (
                <div className="space-y-3">
                  {sshPublic ? (
                    <>
                      <p className="text-[13px] text-muted-foreground">{g.sshAddHint}</p>
                      <div className="flex items-start gap-2">
                        <code className="min-w-0 flex-1 break-all rounded-lg bg-muted/50 px-3 py-2 font-mono text-xs text-foreground">
                          {sshPublic}
                        </code>
                        <button
                          type="button"
                          onClick={copyKey}
                          className="shrink-0 rounded-lg border border-border p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
                          title={g.copy}
                        >
                          {copied ? (
                            <Check className="size-4 text-success" />
                          ) : (
                            <Copy className="size-4" />
                          )}
                        </button>
                      </div>
                      <a
                        href="https://github.com/settings/keys"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 text-[13px] font-medium text-primary hover:underline"
                      >
                        {g.openGithubKeys} <ExternalLink className="size-3.5" />
                      </a>
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={genKey}
                      disabled={busy}
                      className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <KeyRound className="size-4" />
                      )}
                      {g.sshGenerate}
                    </button>
                  )}
                </div>
              )}

              {tab === "ssh-deploy-key" && (
                <div className="space-y-3">
                  <p className="text-[13px] text-muted-foreground">{g.deployKeyHint}</p>
                  {status?.mode === "ssh-deploy-key" ? (
                    <p className="text-[13px] text-success">
                      {status.deployKeyCount > 0
                        ? `${status.deployKeyCount} ${g.deployKeysRegistered}`
                        : g.deployKeyActive}
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={useDeployKeys}
                      disabled={busy}
                      className="inline-flex items-center gap-2 rounded-lg bg-foreground px-4 py-2 text-[13px] font-medium text-background transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      <Terminal className="size-4" /> {g.deployKeyUse}
                    </button>
                  )}
                </div>
              )}
            </div>

            {status?.connected && (
              <div className="mt-4 border-t border-border/40 pt-3">
                <button
                  type="button"
                  onClick={disconnect}
                  disabled={busy}
                  className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-destructive disabled:opacity-50"
                >
                  <Trash2 className="size-3.5" /> {g.disconnect}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * Open the per-server GitHub connect model in a modal — the shared entry point
 * for the deploy credential flow and any "connect GitHub" empty state. Returns
 * `open(serverId, { onConnected })`; the modal self-closes on a successful
 * connection and then fires `onConnected` (e.g. to retry the deploy).
 */
export function useServerGitHubConnectModal() {
  const { showModal, hideModal } = useModal();
  return useCallback(
    (serverId: string, opts?: { onConnected?: () => void }) => {
      let id = "";
      id = showModal({
        customContent: (
          <div className="p-6">
            <ServerGitHubConnect
              serverId={serverId}
              variant="bare"
              onConnected={() => {
                hideModal(id);
                opts?.onConnected?.();
              }}
            />
          </div>
        ),
        maxWidth: "640px",
      });
      return id;
    },
    [showModal, hideModal],
  );
}
