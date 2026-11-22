"use client";

import Link from "next/link";
import { Icon as UiIcon } from "@repo/ui/icons";
import type { GitConnection } from "@/context/GitContext";
import { GitConnectionStatusRow } from "@/components/git/GitConnectionStatusRow";
import { GitProviderSelect } from "@/components/git/GitProviderSelect";
import { useI18n } from "@/components/i18n-provider";
import type { RepoPageMeta } from "../useLibraryRepos";

interface LibrarySidebarProps {
  connection: GitConnection;
  counts: Pick<RepoPageMeta, "total" | "publicCount" | "privateCount">;
  showProviderSelect: boolean;
}

export function LibrarySidebar({ connection, counts, showProviderSelect }: LibrarySidebarProps) {
  const { t } = useI18n();
  return (
    <aside
      aria-label={t.library.sidebar.connection}
      className="contents lg:sticky lg:top-6 lg:col-start-2 lg:row-start-1 lg:flex lg:flex-col lg:gap-4 lg:self-start"
    >
      <section
        className={`rounded-2xl bg-card p-5 ${showProviderSelect ? "order-first" : "order-last"}`}
      >
        <div className="mb-3 flex min-w-0 items-center justify-between gap-2">
          <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
            {!showProviderSelect && <UiIcon name={connection.icon} className="size-4 shrink-0" />}
            <span className="truncate">
              {showProviderSelect ? t.library.sidebar.connection : connection.definition.name}
            </span>
          </h2>
          <Link
            href={connection.settingsHref}
            aria-label={t.actions.completion.manageConnection}
            title={t.actions.completion.manageConnection}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <UiIcon name="settings" className="size-4" />
          </Link>
        </div>
        {showProviderSelect && <GitProviderSelect segmented />}
        <div className="mt-4">
          {connection.renderConnectionStatus?.() ?? (
            <GitConnectionStatusRow
              icon={connection.loading ? "spinner" : connection.icon}
              label={
                connection.loading
                  ? t.library.sidebar.checking
                  : connection.connected
                    ? connection.selectedOwner || connection.definition.name
                    : t.library.sidebar.notConnected
              }
              connected={connection.connected && !connection.loading}
            />
          )}
        </div>
      </section>
      {connection.connected && counts.total > 0 && (
        <div className="order-last rounded-2xl bg-card p-5">
          <div className="flex items-center gap-2 mb-4">
            <UiIcon name="book" className="size-4 text-muted-foreground" />
            <h3 className="font-semibold text-foreground text-sm">{t.library.sidebar.overview}</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                  <UiIcon name="git-branch" className="size-4 text-primary" />
                </div>
                <span className="text-sm text-muted-foreground">{t.library.sidebar.total}</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{counts.total}</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
                  <UiIcon name="globe" className="size-4 text-blue-500" />
                </div>
                <span className="text-sm text-muted-foreground">{t.library.sidebar.public}</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{counts.publicCount}</span>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center">
                  <UiIcon name="lock" className="size-4 text-orange-500" />
                </div>
                <span className="text-sm text-muted-foreground">{t.library.sidebar.private}</span>
              </div>
              <span className="text-lg font-semibold text-foreground">{counts.privateCount}</span>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
