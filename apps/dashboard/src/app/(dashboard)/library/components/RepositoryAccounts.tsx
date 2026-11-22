"use client";

import { DEFAULT_GIT_PROVIDER, gitProviderDefinition } from "@repo/core";
import { Icon, isIconName } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface RepositoryAccountsProps {
  provider?: string;
  accounts: { login: string; avatar_url: string }[];
  selectedOwner: string;
  onSelectOwner: (login: string) => void;
  onAddAccount: () => void;
  addingAccount: boolean;
  onImportUrl?: () => void;
  importingUrl?: boolean;
}

/** Shared source controls for repository browsing and URL import. */
export function RepositoryAccounts({
  provider = DEFAULT_GIT_PROVIDER,
  accounts,
  selectedOwner,
  onSelectOwner,
  onAddAccount,
  addingAccount,
  onImportUrl,
  importingUrl = false,
}: RepositoryAccountsProps) {
  const { t } = useI18n();
  const definition = gitProviderDefinition(provider);
  const icon = definition && isIconName(definition.icon) ? definition.icon : "git-branch";

  const addLabel = interpolate(t.library.repositoryList.addAccount, { provider: definition?.name ?? provider });

  return (
    <div className="flex min-w-0 items-center gap-2">
      <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto no-scrollbar p-0.5">
        {accounts.length ? (
          accounts.map((account) => (
            <Button
              key={account.login}
              type="button"
              variant="ghost"
              onClick={() => onSelectOwner(account.login)}
              aria-pressed={!importingUrl && selectedOwner === account.login}
              className={`h-9 shrink-0 rounded-lg px-3 ${!importingUrl && selectedOwner === account.login ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
            >
              {account.avatar_url ? (
                <img src={account.avatar_url} alt="" className="size-5 rounded-full" />
              ) : (
                <Icon name={icon} className="size-5" aria-hidden="true" />
              )}
              {account.login}
            </Button>
          ))
        ) : (
          <Button
            type="button"
            variant="ghost"
            onClick={() => onSelectOwner(selectedOwner)}
            aria-pressed={!importingUrl}
            className={`h-9 shrink-0 rounded-lg px-3 ${!importingUrl ? "bg-primary/10 text-primary" : "text-muted-foreground"}`}
          >
            <Icon name={icon} className="size-4" aria-hidden="true" />
            {definition?.name ?? provider}
          </Button>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onAddAccount}
          disabled={addingAccount}
          aria-label={addLabel}
          title={addLabel}
          className="rounded-lg"
        >
          <Icon
            name={addingAccount ? "spinner" : "plus"}
            className={`size-4 ${addingAccount ? "animate-spin" : ""}`}
            aria-hidden="true"
          />
        </Button>
        {onImportUrl && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={onImportUrl}
            aria-label={t.library.urlImport.title}
            title={t.library.urlImport.title}
            aria-pressed={importingUrl}
            className={`rounded-lg ${importingUrl ? "bg-primary/10 text-primary" : ""}`}
          >
            <Icon name="link" className="size-4" aria-hidden="true" />
          </Button>
        )}
      </div>
    </div>
  );
}
