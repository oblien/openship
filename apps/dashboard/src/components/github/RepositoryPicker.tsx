"use client";
import { GitProviderSelect } from "@/components/git/GitProviderSelect";
import { useId } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { useGit } from "@/context/GitContext";
import type { RepositorySummary } from "@/lib/git-types";
import { interpolate, useI18n } from "@/components/i18n-provider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { RepositoryList } from "@/app/(dashboard)/library/components/RepositoryList";
import { useLibraryRepos } from "@/app/(dashboard)/library/useLibraryRepos";
import { ActionError } from "@/components/actions/ActionStatus";

/** Shared Library accounts, authentication and pagination, with a selection callback. */
export function RepositoryPicker({
  provider,
  onSelect,
  onClose,
}: {
  provider?: string;
  onSelect: (owner: string, repo: RepositorySummary, provider: string) => void;
  onClose: () => void;
}) {
  const connection = useGit(provider);
  const { t } = useI18n();
  const title = useId();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  const page = useLibraryRepos(
    connection.selectedOwner,
    connection.connected,
    connection.definition.id,
    connection.catalog,
  );
  return (
    <Modal isOpen onClose={onClose} showCloseButton={false} width="760px" maxWidth="95vw">
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="min-w-0 outline-none"
      >
        <header className="flex items-center justify-between gap-3 p-5">
          <h2 id={title} className="text-base font-semibold">
            {t.actions.integration.chooseRepo}
          </h2>
          <Button variant="ghost" size="icon" onClick={onClose} aria-label={t.actions.cancel}>
            <Icon name="close" />
          </Button>
        </header>
        {!provider && (
          <div className="px-5">
            <GitProviderSelect />
          </div>
        )}
        {!connection.connected ? (
          <div className="px-5 pb-5">
            <p className="mb-4 text-sm text-muted-foreground">
              {interpolate(t.actions.integration.connectRepo, {
                provider: connection.definition.name,
              })}
            </p>
            <Button asChild variant="secondary">
              <Link href={connection.settingsHref}>{t.library.connect.manageInSettings}</Link>
            </Button>
          </div>
        ) : page.error ? (
          <div className="px-5 pb-5">
            <ActionError message={page.error} onRetry={page.refresh} />
          </div>
        ) : (
          <RepositoryList
            provider={connection.definition.id}
            repos={page.repos}
            accounts={connection.accounts}
            selectedOwner={connection.selectedOwner}
            setSelectedOwner={connection.setSelectedOwner}
            loading={connection.loading}
            loadingRepos={page.loading}
            onSelect={(owner, repo) => onSelect(owner, repo, connection.definition.id)}
            installUrl={connection.installUrl}
            installing={connection.connecting}
            onInstall={connection.connectMore}
            server={{
              search: page.search,
              onSearch: page.setSearch,
              visibility: page.visibility,
              onVisibility: page.setVisibility,
              sort: page.sort,
              onSort: page.setSort,
              page: page.page,
              totalPages: page.meta.totalPages,
              onPage: page.setPage,
              count: page.meta.count,
            }}
          />
        )}
      </div>
    </Modal>
  );
}
