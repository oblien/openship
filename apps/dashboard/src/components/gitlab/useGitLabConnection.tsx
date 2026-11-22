"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { GITLAB_PROVIDER, gitProviderSettingsHref } from "@repo/core";
import type { GitRepositorySummary } from "@repo/contracts";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { credentialsApi } from "@/lib/api/credentials";
import { useResourceScope, useScopedResource } from "@/hooks/use-scoped-resource";
import { CredentialForm } from "@/components/credentials/CredentialForm";
import type { GitConnection } from "@/context/GitContext";
import { useCloudResourceReady } from "@/context/CloudResourceContext";
import { gitApi, gitSourcesChangedEvent } from "@/lib/api/git";
import { getApiErrorCode, getApiErrorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Icon } from "@repo/ui/icons";
import { AppLogo } from "@repo/ui/app-logo";
import { RepositoryConnectState } from "@/components/git/RepositoryConnectState";
import { repositorySummary } from "@/lib/git-types";
import { Modal } from "@/components/ui/Modal";
import { useDialogFocus } from "@/hooks/useDialogFocus";

function GitLabConnectionForm({ onClose }: { onClose(): void }) {
  const { t } = useI18n();
  const { data, error, refresh } = useScopedResource(credentialsApi.providers);
  const provider = data?.data.find((item) => item.id === GITLAB_PROVIDER.id);
  if (!provider) {
    if (!error && !data) return <p role="status">{t.settings.common.loading}</p>;
    return (
      <div className="space-y-3">
        <p role="alert">{error ?? t.settings.credentials.noProviders}</p>
        <Button type="button" variant="secondary" onClick={refresh}>
          {t.onboarding.loading.retry}
        </Button>
      </div>
    );
  }
  return (
    <CredentialForm
      provider={provider}
      onCancel={onClose}
      onSaved={() => {
        onClose();
        window.dispatchEvent(new Event(gitSourcesChangedEvent(provider.id)));
      }}
    />
  );
}

function GitLabConnectionDialog({ title, onClose }: { title: string; onClose(): void }) {
  const { t } = useI18n();
  const titleId = useId();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  return (
    <Modal isOpen onClose={onClose} width="480px" maxWidth="100%" showCloseButton={false}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="space-y-5 p-5 outline-none sm:p-6"
      >
        <header className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="grid size-10 shrink-0 place-items-center rounded-xl bg-card"
          >
            <AppLogo appId={GITLAB_PROVIDER.id} icon={GITLAB_PROVIDER.icon} className="size-6" />
          </span>
          <h2 id={titleId} className="flex-1 text-lg font-semibold text-foreground">
            {title}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label={t.settings.common.close}
          >
            <Icon name="close" aria-hidden="true" />
          </Button>
        </header>
        <GitLabConnectionForm onClose={onClose} />
      </div>
    </Modal>
  );
}

export function useGitLabConnection(): GitConnection {
  const { t } = useI18n();
  const connectLabel = () =>
    interpolate(t.projectSettings.git.connectFirst.connect, { provider: GITLAB_PROVIDER.name });
  const [showConnect, setShowConnect] = useState(false);
  const resource = useResourceScope();
  const ready = useCloudResourceReady();
  const [enabled, setEnabled] = useState(false);
  const activate = useCallback(() => setEnabled(true), []);
  const [state, setState] = useState<{
    resource: string;
    rows: GitRepositorySummary[];
    connected: boolean;
    error?: string;
  }>();
  const [loading, setLoading] = useState(false);
  const [owner, selectOwner] = useState("");
  const request = useRef(0);
  const refresh = useCallback(async () => {
    if (!enabled || !ready) return;
    const version = ++request.current;
    setLoading(true);
    try {
      const { data } = await gitApi(GITLAB_PROVIDER.id).getUserRepos(undefined, undefined, true);
      if (version === request.current) setState({ resource, rows: data, connected: true });
    } catch (error) {
      if (version === request.current)
        setState({
          resource,
          rows: [],
          connected: false,
          error:
            getApiErrorCode(error) === "GIT_CONNECTION_REQUIRED"
              ? undefined
              : getApiErrorMessage(error),
        });
    } finally {
      if (version === request.current) setLoading(false);
    }
  }, [enabled, resource, ready]);
  useEffect(() => {
    void refresh();
    const event = gitSourcesChangedEvent(GITLAB_PROVIDER.id);
    window.addEventListener(event, refresh);
    return () => {
      ++request.current;
      window.removeEventListener(event, refresh);
    };
  }, [refresh]);
  const current = ready && state?.resource === resource ? state : undefined;
  const rows = current?.rows;
  const accounts = useMemo(
    () => [...new Set(rows?.map((row) => row.owner))].map((login) => ({ login, avatar_url: "" })),
    [rows],
  );
  const selectedOwner = accounts.some((a) => a.login === owner)
    ? owner
    : (accounts[0]?.login ?? "");
  const repos = useMemo(
    () => rows?.filter((row) => row.owner === selectedOwner).map(repositorySummary) ?? [],
    [rows, selectedOwner],
  );
  const open = () => setShowConnect(true);
  const connectionDialog = (onClose: () => void) => (
    <GitLabConnectionDialog title={connectLabel()} onClose={onClose} />
  );
  return {
    definition: GITLAB_PROVIDER,
    icon: GITLAB_PROVIDER.icon,
    activate,
    dialog: showConnect ? connectionDialog(() => setShowConnect(false)) : null,
    connected: current?.connected ?? false,
    connecting: false,
    loading: enabled && (loading || !current),
    accounts,
    selectedOwner,
    setSelectedOwner: selectOwner,
    repos,
    catalog: { rows: repos, refresh },
    loadingRepos: loading,
    installUrl: null,
    async connect() {
      open();
    },
    connectMore: open,
    refresh,
    async fetchReposForOwner(owner) {
      selectOwner(owner);
    },
    consentRequired: false,
    renderConsent: () => null,
    renderConnect: ({ header, onBrowseApps }) => (
      <RepositoryConnectState
        provider={GITLAB_PROVIDER.name}
        header={header}
        onBrowseApps={onBrowseApps}
        description={
          current?.error ? (
            <span role="alert">{current.error}</span>
          ) : (
            t.library.connect.default.descSelfHosted
          )
        }
      >
        {current?.error ? (
          <Button type="button" onClick={refresh} className="h-11 px-6">
            {t.onboarding.loading.retry}
          </Button>
        ) : (
          <Button type="button" onClick={open} className="h-11 px-6">
            <Icon name={GITLAB_PROVIDER.icon} className="size-4" aria-hidden="true" />
            {connectLabel()}
          </Button>
        )}
      </RepositoryConnectState>
    ),
    renderManageConnection: ({ onClose }) => connectionDialog(onClose),
    settingsHref: gitProviderSettingsHref(GITLAB_PROVIDER.id),
  };
}
