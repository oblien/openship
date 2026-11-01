"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

/**
 * The ⋮ help menu — support / report issue / feedback / docs / community.
 *
 * One definition, so every page header offers the same set of links in the same
 * order (it was previously inline in the project-detail page only). Drop it next
 * to a page's primary action.
 */

import DropdownMenu, { type MenuAction } from "@/components/ui/DropdownMenu";
import { useI18n } from "@/components/i18n-provider";
import { BRAND_LINKS } from "@repo/core";

/* Shared with the desktop app's NATIVE Help menu (apps/desktop/src/main/menu.ts),
   which cannot import from here. They were the same five URLs typed twice — which
   is how a docs link goes dead in one menu and stays fine in the other. */
const SUPPORT_URL = BRAND_LINKS.support;
const ISSUE_URL = BRAND_LINKS.issues;
const FEEDBACK_URL = BRAND_LINKS.contact;
const DOCS_URL = BRAND_LINKS.docs;
const COMMUNITY_URL = BRAND_LINKS.community;

const open = (url: string) => window.open(url, "_blank", "noopener,noreferrer");

/** The actions themselves — exported so a page can append its own items. */
export function useHelpMenuActions(): MenuAction[] {
  const { t } = useI18n();
  return [
    {
      id: "support",
      label: t.projects.help.contactSupport,
      icon: <UiIcon name="help-circle" className="size-4" />,
      onClick: () => open(SUPPORT_URL),
    },
    {
      id: "report-issue",
      label: t.projects.help.reportIssue,
      icon: <UiIcon name="bug" className="size-4" />,
      onClick: () => open(ISSUE_URL),
    },
    {
      id: "feedback",
      label: t.projects.help.sendFeedback,
      icon: <UiIcon name="message" className="size-4" />,
      onClick: () => open(FEEDBACK_URL),
    },
    { id: "divider", divider: true },
    {
      id: "documentation",
      label: t.projects.help.documentation,
      icon: <UiIcon name="book" className="size-4" />,
      onClick: () => open(DOCS_URL),
    },
    {
      id: "community",
      label: t.projects.help.joinCommunity,
      icon: <UiIcon name="external-link" className="size-4" />,
      onClick: () => open(COMMUNITY_URL),
    },
  ];
}

export function HelpMenu({
  /** Extra page-specific items, prepended above the standard help links. */
  extraActions,
  className,
}: {
  extraActions?: MenuAction[];
  className?: string;
}) {
  const help = useHelpMenuActions();
  const actions = extraActions?.length
    ? [...extraActions, { id: "extra-divider", divider: true }, ...help]
    : help;
  return (
    <DropdownMenu
      actions={actions}
      align="right"
      className={className}
      trigger={<UiIcon name="more-vertical" className="size-5 text-muted-foreground" />}
    />
  );
}
