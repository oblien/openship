"use client";

import { useRef } from "react";
import { Icon } from "@repo/ui/icons";
import { useDocsSearch } from "fumadocs-core/search/client";
import { fetchClient } from "fumadocs-core/search/client/fetch";
import { useI18n } from "fumadocs-ui/contexts/i18n";
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogFooter,
  SearchDialogHeader,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search";

/** Keep Fumadocs' search, results and keyboard handling in the shared docs shell. */
export function DocsSearch(props: SharedProps) {
  const { locale } = useI18n();
  const search = useDocsSearch({ client: fetchClient({ locale }) });
  const returnFocus = useRef<HTMLElement | null>(null);

  return (
    <SearchDialog
      {...search}
      {...props}
      onSelect={() => {
        returnFocus.current = null;
      }}
    >
      <SearchDialogOverlay />
      <SearchDialogContent
        className="docs-search"
        onOpenAutoFocus={() => {
          returnFocus.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocus.current?.focus();
        }}
      >
        <SearchDialogHeader>
          <Icon
            name={search.isLoading ? "spinner" : "search"}
            size={20}
            className={search.isLoading ? "animate-spin" : undefined}
          />
          <SearchDialogInput />
          <SearchDialogClose className="docs-search-close">
            <Icon name="close" size={16} />
          </SearchDialogClose>
        </SearchDialogHeader>
        <SearchDialogList />
        <SearchDialogFooter className="docs-search-footer">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> Navigate
          </span>
          <span>
            <kbd>↵</kbd> Open
          </span>
          <span>
            <kbd>Esc</kbd> Close
          </span>
        </SearchDialogFooter>
      </SearchDialogContent>
    </SearchDialog>
  );
}
