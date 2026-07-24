"use client";

import { useState } from "react";
import { Gitlab, Unplug, RefreshCw, Key, ExternalLink } from "lucide-react";
import { useGitLab } from "@/context/GitLabContext";
import { useModal } from "@/context/ModalContext";
import { useToast } from "@/context/ToastContext";
import { SettingsSection } from "./SettingsSection";

/**
 * GitLab connection card — simpler than GitHub's: a single credential slot
 * per user (OAuth or a personal access token, whichever was set last) rather
 * than GitHub's dual App/CLI sources. Supports both a one-click OAuth
 * connect and a PAT paste form for self-managed GitLab instances / users who
 * don't want to grant OAuth.
 */
export function GitLabConnection() {
  const {
    state,
    connected,
    connecting,
    loading,
    connect,
    connectWithToken,
    disconnect,
  } = useGitLab();
  const { showModal, hideModal } = useModal();
  const { showToast } = useToast();

  const [showPatForm, setShowPatForm] = useState(false);
  const [pat, setPat] = useState("");
  const [patBaseUrl, setPatBaseUrl] = useState("");
  const [submittingPat, setSubmittingPat] = useState(false);

  const effectivePatBase =
    (patBaseUrl.trim() || state.baseUrl || "https://gitlab.com").replace(/\/$/, "");

  const promptDisconnect = () => {
    const modalId = showModal({
      title: "Disconnect GitLab?",
      message:
        "This removes your GitLab connection from Openship. Projects already linked to a GitLab repo keep their link, but you'll need to reconnect to browse or bind new ones.",
      buttons: [
        { label: "Cancel", variant: "secondary", onClick: () => hideModal(modalId) },
        {
          label: "Disconnect",
          variant: "danger",
          onClick: async () => {
            hideModal(modalId);
            await disconnect("all");
          },
        },
      ],
    });
  };

  const openPatForm = () => {
    setShowPatForm((v) => {
      if (!v) setPatBaseUrl(state.baseUrl || "https://gitlab.com");
      return !v;
    });
  };

  const handlePatSubmit = async () => {
    const token = pat.trim();
    if (!token) return;
    setSubmittingPat(true);
    try {
      const res = await connectWithToken(token, effectivePatBase);
      if (res.success) {
        setPat("");
        setShowPatForm(false);
        showToast("GitLab connected", "success", "GitLab");
      } else if (res.error) {
        showToast(res.error, "error", "GitLab");
      }
    } finally {
      setSubmittingPat(false);
    }
  };

  return (
    <SettingsSection
      icon={Gitlab}
      title={connected && state.login ? `GitLab — @${state.login}` : "GitLab"}
      description={
        connected
          ? state.mode === "pat"
            ? `Connected via personal access token · ${state.baseUrl}`
            : "Connected via OAuth"
          : "Connect GitLab to browse and deploy your projects"
      }
      iconBg="bg-orange-500/10"
      iconColor="text-orange-500"
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          Checking connection…
        </div>
      ) : connected ? (
        <div className="space-y-4">
          <div className="flex items-center gap-3 px-3 py-2 bg-muted/30 rounded-lg border border-border/40 w-fit">
            {state.avatarUrl ? (
              <img src={state.avatarUrl} alt={state.login ?? ""} className="size-7 rounded-full" />
            ) : (
              <div className="size-7 rounded-full bg-muted flex items-center justify-center">
                <Gitlab className="size-3.5 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground truncate">@{state.login}</p>
            </div>
            <span className="text-[10px] font-medium text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full">
              {state.mode === "pat" ? "PAT" : "OAuth"}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <a
              href={`${state.baseUrl}/-/user_settings/applications`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
            >
              Manage on GitLab
              <ExternalLink className="size-3" />
            </a>
            <button
              onClick={promptDisconnect}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-danger bg-danger-bg hover:bg-danger-bg rounded-lg border border-danger-border transition-colors"
            >
              <Unplug className="size-3.5" />
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Connect a GitLab account to browse namespaces, deploy projects, and
            bind existing projects to a GitLab repo.
          </p>

          <div className="flex flex-wrap items-center gap-2">
            {state.oauthConfigured && (
              <button
                onClick={connect}
                disabled={connecting}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium bg-foreground text-background hover:bg-foreground/90 rounded-xl transition-colors disabled:opacity-50"
              >
                {connecting ? (
                  <>
                    <RefreshCw className="size-4 animate-spin" />
                    Connecting…
                  </>
                ) : (
                  <>
                    <Gitlab className="size-4" />
                    Connect GitLab
                  </>
                )}
              </button>
            )}
            <button
              onClick={openPatForm}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
            >
              <Key className="size-3.5" />
              {showPatForm ? "Cancel" : "Use a personal access token"}
            </button>
          </div>

          {showPatForm && (
            <div className="space-y-2 pt-1">
              <label className="block space-y-1">
                <span className="text-xs text-muted-foreground">GitLab URL</span>
                <input
                  type="url"
                  value={patBaseUrl}
                  onChange={(e) => setPatBaseUrl(e.target.value)}
                  placeholder="https://gitlab.com"
                  className="w-full px-3 py-1.5 text-sm rounded-lg border border-border/50 bg-background text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
              </label>
              <p className="text-xs text-muted-foreground/70">
                Create a token with the <code className="px-1 py-0.5 rounded bg-muted/60 font-mono">api</code>{" "}
                scope at{" "}
                <a
                  href={`${effectivePatBase}/-/user_settings/personal_access_tokens`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-foreground underline underline-offset-2"
                >
                  {effectivePatBase}/-/user_settings/personal_access_tokens
                </a>
                .
              </p>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  value={pat}
                  onChange={(e) => setPat(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handlePatSubmit();
                  }}
                  placeholder="glpat-xxxxxxxxxxxxxxxxxxxx"
                  className="flex-1 min-w-0 px-3 py-1.5 text-sm rounded-lg border border-border/50 bg-background text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button
                  onClick={handlePatSubmit}
                  disabled={!pat.trim() || submittingPat}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-foreground text-background hover:bg-foreground/90 rounded-lg transition-colors disabled:opacity-50"
                >
                  {submittingPat ? <RefreshCw className="size-3.5 animate-spin" /> : "Connect"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </SettingsSection>
  );
}
