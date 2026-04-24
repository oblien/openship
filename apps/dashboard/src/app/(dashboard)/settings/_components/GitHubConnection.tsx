"use client";

import { Github, ExternalLink, Unplug, RefreshCw, Download } from "lucide-react";
import { useGitHub } from "@/context/GitHubContext";
import { useModal } from "@/context/ModalContext";
import { SettingsSection } from "./SettingsSection";

export function GitHubConnection() {
  const {
    connected,
    connecting,
    loading,
    userLogin,
    accounts,
    connect,
    disconnect,
    installUrl,
  } = useGitHub();

  const { showModal, hideModal } = useModal();

  const handleDisconnect = () => {
    const modalId = showModal({
      title: "Disconnect GitHub",
      message:
        "Are you sure you want to disconnect your GitHub account? You can reconnect anytime.",
      buttons: [
        {
          label: "Cancel",
          variant: "secondary",
          onClick: () => hideModal(modalId),
        },
        {
          label: "Disconnect",
          variant: "danger",
          onClick: async () => {
            hideModal(modalId);
            await disconnect();
          },
        },
      ],
    });
  };

  const hasInstallations = accounts.length > 0;

  return (
    <SettingsSection
      icon={Github}
      title={connected && userLogin ? `GitHub · @${userLogin}` : "GitHub"}
      description={
        connected
          ? hasInstallations
            ? `Connected · ${accounts.length} account${accounts.length > 1 ? "s" : ""}`
            : "Connected · No installations yet"
          : "Connect your GitHub account to deploy repositories"
      }
      iconBg="bg-foreground/5"
      iconColor="text-foreground"
    >
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
          Checking connection…
        </div>
      ) : connected ? (
        <div className="space-y-4">
          {/* Installations list */}
          {hasInstallations && (
            <div className="space-y-2">
              {accounts.map((acct) => (
                <div
                  key={acct.login}
                  className="flex items-center gap-3 px-3 py-2 bg-muted/30 rounded-lg border border-border/40"
                >
                  {acct.avatar_url ? (
                    <img
                      src={acct.avatar_url}
                      alt={acct.login}
                      className="size-7 rounded-full"
                    />
                  ) : (
                    <div className="size-7 rounded-full bg-muted flex items-center justify-center">
                      <Github className="size-3.5 text-muted-foreground" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">
                      {acct.login}
                    </p>
                  </div>
                  <span className="text-[10px] font-medium text-muted-foreground bg-muted/50 px-2 py-0.5 rounded-full">
                    {acct.type === "Organization" ? "Org" : "User"}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-2">
            {installUrl && (
              <a
                href={installUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
              >
                <Download className="size-3.5" />
                {hasInstallations ? "Add account" : "Install GitHub App"}
              </a>
            )}
            <a
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground bg-muted/40 hover:bg-muted/60 rounded-lg border border-border/50 transition-colors"
            >
              Manage on GitHub
              <ExternalLink className="size-3" />
            </a>
            <button
              onClick={handleDisconnect}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-600 hover:text-red-700 bg-red-500/5 hover:bg-red-500/10 rounded-lg border border-red-500/15 hover:border-red-500/25 transition-colors"
            >
              <Unplug className="size-3.5" />
              Disconnect
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground leading-relaxed">
            Link your GitHub account to import repositories, enable auto-deploy
            on push, and manage branches directly from the dashboard.
          </p>
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
                <Github className="size-4" />
                Connect GitHub
              </>
            )}
          </button>
        </div>
      )}
    </SettingsSection>
  );
}
