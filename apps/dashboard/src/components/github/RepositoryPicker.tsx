"use client";
import { useId } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { useGitHub, type GitHubRepo } from "@/context/GitHubContext";
import { useI18n } from "@/components/i18n-provider";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { useDialogFocus } from "@/hooks/useDialogFocus";
import { RepositoryList } from "@/app/(dashboard)/library/components/RepositoryList";
import { useLibraryRepos } from "@/app/(dashboard)/library/useLibraryRepos";
import { ActionError } from "@/components/actions/ActionStatus";

/** Shared Library accounts, authentication and pagination, with a selection callback. */
export function RepositoryPicker({
  onSelect,
  onClose,
}: {
  onSelect: (owner: string, repo: GitHubRepo) => void;
  onClose: () => void;
}) {
  const github = useGitHub();
  const { t } = useI18n();
  const title = useId();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  const page = useLibraryRepos(github.selectedOwner, github.connected);
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
        {!github.connected ? (
          <div className="px-5 pb-5">
            <p className="mb-4 text-sm text-muted-foreground">
              {t.actions.integration.connectRepo}
            </p>
            <Button asChild variant="secondary">
              <Link href="/settings?tab=git">{t.library.connect.manageInSettings}</Link>
            </Button>
          </div>
        ) : page.error ? (
          <div className="px-5 pb-5">
            <ActionError message={page.error} onRetry={page.refresh} />
          </div>
        ) : (
          <RepositoryList
            repos={page.repos}
            accounts={github.accounts}
            selectedOwner={github.selectedOwner}
            setSelectedOwner={github.setSelectedOwner}
            loading={github.loading}
            loadingRepos={page.loading}
            onSelect={onSelect}
            installUrl={github.installUrl}
            installing={github.connecting}
            onInstall={() => void github.connect("oauth")}
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
