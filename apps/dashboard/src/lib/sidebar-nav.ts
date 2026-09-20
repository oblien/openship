/**
 * The sidebar's nav model — pure data, no React, so both shapes of the rail are
 * unit-testable without rendering a sidebar.
 *
 * Two products share one shell:
 *   - `getNavSections()`     → the full deploy platform.
 *   - `getMailNavSections()` → Openship Mail: /emails' ten admin tabs promoted
 *                              to rail entries across three headings, plus the
 *                              host and settings rows an operator still needs.
 *
 * Mail entries are `?tab=` links into the single /emails route, so the ten tab
 * components are untouched by this. That's also why NavItem carries `tab`:
 * those entries share one pathname, so "is this active" can't be answered from
 * the path alone. Webmail is the one exception — it's a project, not a tab, and
 * gets a route of its own (see `webmailHref`).
 */

import {
  Activity,
  AppWindow,
  Bell,
  Building2,
  Clock,
  CreditCard,
  DatabaseBackup,
  FileText,
  FolderKanban,
  Forward,
  Globe,
  HeartPulse,
  LayoutDashboard,
  Mail,
  MailPlus,
  Rocket,
  Server,
  Settings,
  ClipboardList,
  ShieldAlert,
  SlidersHorizontal,
  UserRound,
  Waypoints,
} from "lucide-react";

import { canonicalMailTab, type MailTabKey } from "./mail-tabs";

export type NavIcon = React.ComponentType<{ className?: string; strokeWidth?: number }>;

/** Where an item's label comes from. Mail tab labels already exist, translated
 *  across all 9 locales, under `t.emailsAdmin.panel.tabs` — reusing them means
 *  promoting the tabs to the rail adds no new translation surface. */
export type NavLabelSource = "nav" | "mailTab";

export interface NavItem {
  key: string;
  href: string;
  icon: NavIcon;
  /** Defaults to "nav" (`t.dashboard.nav[key]`). */
  labelSource?: NavLabelSource;
  /**
   * Set on items that are one route distinguished by `?tab=`. When present the
   * item is active only if the URL's tab matches — without it every mail entry
   * would highlight at once, since they all live at /emails.
   */
  tab?: string;
  /**
   * Extra pathnames this item also owns, for the active highlight only — `href`
   * stays the canonical link. Openship Mail renders the mail console at `/` as
   * well as /emails (`(dashboard)/page.tsx`), and `/` is where login lands; with
   * no entry claiming it the operator arrives on a rail highlighting nothing.
   */
  alsoAt?: string[];
  /** Nested items shown indented beneath this one (e.g. Apps under Projects). */
  children?: NavItem[];
}

export interface NavSection {
  /** i18n key under t.dashboard.nav.sections */
  section?: string;
  items: NavItem[];
}

const MAIN_ITEMS: NavItem[] = [
  { key: "home", href: "/", icon: LayoutDashboard },
  { key: "projects", href: "/projects", icon: FolderKanban },
  { key: "apps", href: "/apps", icon: Building2 },
  { key: "deployments", href: "/deployments", icon: Rocket },
  // MAIN, not infrastructure: `/api/issues` reports project, domain and update items on
  // the SaaS too (only the server/container sources resolve empty there), and the
  // infrastructure section is `if (selfHosted)` — putting Issues in it would delete the
  // page from cloud. No count badge: the nav's single getHome() fetch carries no issue
  // total, and a badge here would be the only notification-style one in the rail.
  { key: "issues", href: "/monitoring", icon: HeartPulse },
];

/** Build nav sections dynamically */
export function getNavSections(isSaaS: boolean, selfHosted: boolean): NavSection[] {
  const settingsItems: NavItem[] = [
    { key: "backups", href: "/backups", icon: DatabaseBackup },
    { key: "settings", href: "/settings", icon: Settings },
  ];
  // LAST row of the LAST section, deliberately. `isSaaS` is true on a self-hosted box
  // the moment it links a cloud account (`!selfHosted || cloudConnected` in
  // sidebar.tsx), and Billing sitting mid-rail there read as "this install is
  // metered" — above Servers, which is what an operator on their own machine
  // actually came for. Cloud credits are real, so the entry stays; it just stops
  // outranking the infrastructure.
  if (isSaaS) {
    settingsItems.push({ key: "billing", href: "/billing", icon: CreditCard });
  }
  // Audit log, last row of the rail. Promoted out of Settings: it is not a setting — you
  // never change anything here, you READ what already happened, and burying a
  // review surface three clicks deep behind a settings tab is how it goes unread.
  // Last on purpose: it is consulted after the fact, never on the way to a task.
  settingsItems.push({ key: "audit", href: "/audit", icon: ClipboardList });

  const infraItems: NavItem[] = [];
  if (selfHosted) {
    infraItems.push({ key: "servers", href: "/servers", icon: Server });
    infraItems.push({ key: "emails", href: "/emails", icon: Mail });
    infraItems.push({ key: "jobs", href: "/jobs", icon: Clock });
  }
  // infraItems.push(
  //   { key: "monitoring", href: "/monitoring", icon: Activity },
  //   { key: "domains",    href: "/domains",    icon: Globe },
  // );

  // Infrastructure ahead of settings: self-hosted, Servers is the second thing you
  // reach for after Projects, and it used to sit below Backups/Settings/Billing.
  // On the SaaS the group is empty and filters out, so the rail there is unchanged.
  return [
    { section: "main", items: MAIN_ITEMS },
    { section: "infrastructure", items: infraItems },
    { section: "settings", items: settingsItems },
  ].filter((s) => s.items.length > 0);
}

/* ------------------------------------------------------------------ */
/*  Openship Mail                                                      */
/* ------------------------------------------------------------------ */

/**
 * The ten admin tabs, split into the groups the rail shows them in.
 *
 * The tab bar renders all ten in one row, but ten flat entries under a single
 * "MAIL" heading is a wall of links — and it pushed Servers down to the eleventh
 * row. Three groups instead: what you administer day to day, whether mail is
 * actually flowing, and the machine it runs on. That last group is shared with the
 * host rows (Servers, Jobs), which is what lifts them up the rail.
 *
 * Order inside each group follows `MAIL_TAB_KEYS` (`./mail-tabs`), which the tab
 * bar also renders from — the rail and the tab bar are two views of one list, and
 * the tab bar is still what platform view renders. Grouping is the only thing this
 * file adds; the keys themselves are typed from there, so a section renamed without
 * the rail following is a compile error rather than a row that quietly stops
 * highlighting.
 */
type MailTab = { key: MailTabKey; icon: NavIcon };

/** Mail view's second home for the console — see `NavItem.alsoAt`. Every mail
 *  entry claims it, not just Overview, so `/?tab=domains` highlights Domains the
 *  same way /emails?tab=domains does. */
const MAIL_CONSOLE_ALSO_AT = ["/"];

const MAIL_TABS_PRIMARY: MailTab[] = [
  { key: "overview", icon: LayoutDashboard },
  { key: "domains", icon: Globe },
  { key: "mailboxes", icon: UserRound },
  { key: "aliases", icon: Forward },
  // Notification rules sit with the address space rather than with Delivery:
  // Delivery is about SENDING, and a rule is about what happens to mail arriving
  // at one of the addresses above it.
  { key: "notifications", icon: Bell },
];

/**
 * Sending leads: it's the only DECISION in this group (deliver direct, or relay
 * through a provider), and the other two are checks on whatever it decided — DNS
 * carries the SPF include and send-hop records the relay adds, Health verifies the
 * result. Configure, publish, check. Sending a test email is a check too, and it
 * lives inside Sending rather than as a fourth entry here (see
 * `./mail-tabs`, which still resolves the old `?tab=test`).
 */
const MAIL_TABS_DELIVERY: MailTab[] = [
  { key: "sending", icon: Waypoints },
  { key: "dns", icon: FileText },
  { key: "health", icon: HeartPulse },
];

/** No heading of its own — these ride the infrastructure group under the host
 *  rows, because backups and the danger zone are about the machine, and a fourth
 *  heading is the thing we're getting away from. */
const MAIL_TABS_SERVER: MailTab[] = [
  { key: "backup", icon: DatabaseBackup },
  // The tab bar uses a gear here; the rail can't, because a gear in the tail
  // group already means platform Settings.
  { key: "advanced", icon: SlidersHorizontal },
];

export interface MailNavInput {
  /** False until the mail-server list has come back. */
  loaded: boolean;
  /** Registered mail servers (`mail_servers`), from mailApi.listMailServers(). */
  serverCount: number;
  /** The server the rail is scoped to. */
  activeServerId: string | null;
  /** Its registry `completed` flag — the SAME authority /emails' view gate uses,
   *  so the rail and the page can't disagree about whether a server is installed. */
  activeCompleted: boolean;
  /** Adds Jobs + Servers, which only exist self-hosted. */
  selfHosted: boolean;
}

export function mailTabHref(serverId: string | null, tab: string): string {
  const params = new URLSearchParams();
  if (serverId) params.set("serverId", serverId);
  params.set("tab", tab);
  return `/emails?${params.toString()}`;
}

/**
 * Webmail's rail entry — the one mail item that is NOT a `?tab=` link.
 *
 * Webmail (Zero) ships as an ordinary openship project, so it's managed in the
 * projects UI rather than in a panel of its own. /emails/webmail is the stable
 * address that resolves which of those it is: the project when one exists, an
 * install offer when it doesn't. The rail can therefore link somewhere real
 * without waiting on a status fetch of its own.
 */
export function webmailHref(serverId: string | null): string {
  return serverId
    ? `/emails/webmail?serverId=${encodeURIComponent(serverId)}`
    : "/emails/webmail";
}

/**
 * The one entry the rail shows while there are no ten sections to show, or null
 * once the active server is installed and the grouped shape takes over.
 *
 * A function of mail state, mirroring `resolveMailView()`
 * (`emails/_lib/view-gate.ts`). Without that, a fresh install would show ten
 * entries that all land on the setup wizard, and a half-finished install would
 * offer Mailboxes for a server that has no database yet.
 */
function getMailSetupItem(i: MailNavInput): NavItem | null {
  // Pre-fetch. One entry pointing at the real route — whatever the answer turns
  // out to be, /emails is where it lives, so this is never a dead link and never
  // needs to be walked back. (A ten-entry guess would be wrong on a fresh box;
  // an empty section would make the rail look broken.)
  if (!i.loaded) {
    return { key: "emails", href: "/emails", icon: Mail, alsoAt: MAIL_CONSOLE_ALSO_AT };
  }

  if (i.serverCount === 0 || !i.activeServerId) {
    return { key: "mailSetup", href: "/emails", icon: MailPlus, alsoAt: MAIL_CONSOLE_ALSO_AT };
  }

  if (!i.activeCompleted) {
    return {
      key: "mailSetupProgress",
      href: `/emails?serverId=${encodeURIComponent(i.activeServerId)}`,
      icon: Activity,
      alsoAt: MAIL_CONSOLE_ALSO_AT,
    };
  }

  return null;
}

export function getMailNavSections(i: MailNavInput): NavSection[] {
  const setup = getMailSetupItem(i);
  const tabs = (group: MailTab[]): NavItem[] =>
    setup
      ? [] // nothing to group yet — the setup entry is the whole mail rail
      : group.map(({ key, icon }) => ({
          key,
          href: mailTabHref(i.activeServerId, key),
          icon,
          labelSource: "mailTab" as const,
          tab: key,
          alsoAt: MAIL_CONSOLE_ALSO_AT,
        }));

  // Host rows lead the group: they're the only ones here that exist before a mail
  // server does, and putting them ahead of Backups/Advanced is what pulls Servers
  // up the rail.
  const infraItems: NavItem[] = [];
  if (i.selfHosted) {
    infraItems.push({ key: "servers", href: "/servers", icon: Server });
    infraItems.push({ key: "jobs", href: "/jobs", icon: Clock });
  }
  infraItems.push(...tabs(MAIL_TABS_SERVER));

  // Webmail closes the MAIL group: the five tabs above are what you administer,
  // this is the client your users actually open. Only once the server is
  // installed — before that the mail rail is a single setup entry, and offering
  // to deploy a webmail for a mail server that doesn't serve mail yet is a
  // detour, not a shortcut.
  const mailItems = setup
    ? [setup]
    : [
        ...tabs(MAIL_TABS_PRIMARY),
        { key: "webmail", href: webmailHref(i.activeServerId), icon: AppWindow },
      ];

  return [
    { section: "mail", items: mailItems },
    { section: "delivery", items: tabs(MAIL_TABS_DELIVERY) },
    { section: "infrastructure", items: infraItems },
    // "System" — the box itself rather than the mail on it. Issues is not gated on
    // selfHosted (see MAIN_ITEMS): it reports domain and update problems too, and
    // in mail mode a broken cert or a stale instance is exactly what an operator
    // needs to see. Every other group here carries a heading, so leaving this one
    // bare read as an unfinished rail rather than a deliberate grouping.
    {
      section: "system",
      items: [
        { key: "issues", href: "/monitoring", icon: HeartPulse },
        { key: "settings", href: "/settings", icon: Settings },
      ],
    },
  ].filter((s) => s.items.length > 0);
}

/**
 * Is `item` the current page?
 *
 * Tab items compare the query, everything else compares the path. Both are
 * needed at once: in mail mode the rail is ten entries sharing /emails, but
 * Servers/Jobs/Settings sit right below and still match by prefix.
 *
 * `alsoAt` widens the path half of either test — the console answers on `/` too
 * in mail view, and the query half is unchanged there, so `/` highlights Overview
 * and `/?tab=domains` highlights Domains.
 */
export function isNavItemActive(
  item: NavItem,
  pathname: string,
  currentTab: string | null,
): boolean {
  const owns = (path: string) => pathname === path || !!item.alsoAt?.includes(pathname);

  if (item.tab) {
    // Compared canonical, not raw: the panel resolves a retired `?tab=` to the
    // section that absorbed it, and an exact compare against the raw value would
    // render that section with nothing in the rail lit. Bare /emails renders
    // Overview, which is the null case `canonicalMailTab` already answers.
    return owns(item.href.split("?")[0]) && canonicalMailTab(currentTab) === item.tab;
  }
  // Home is an exact match or it would swallow every route below it.
  if (item.href === "/") return pathname === "/";
  const path = item.href.split("?")[0];
  return owns(path) || pathname.startsWith(path + "/");
}
