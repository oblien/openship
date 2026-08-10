"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  LayoutDashboard,
  FolderKanban,
  Rocket,
  Globe,
  Activity,
  Settings,
  CreditCard,
  LogOut,
  Loader2,
  Moon,
  Sun,
  SunMoon,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Server,
  Mail,
  Clock,
  DatabaseBackup,
  Building2,
  ChevronsUpDown,
  Check,
  ShieldAlert,
} from "lucide-react";
import { authClient, signOut } from "@/lib/auth-client";
import { useTheme } from "@/components/theme-provider";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { Logo } from "@/components/logo";
import { useAuth } from "@/context/AuthContext";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { DismissiblePopover } from "@/components/ui/Popover";
import { setActiveOrganizationId } from "@/lib/api/client";
import { projectsApi } from "@/lib/api";
import {
  getSidebarNavCountsRevision,
  subscribeSidebarNavCounts,
} from "@/lib/sidebar-nav-counts";

/**
 * Org list / member shapes from Better Auth's organization plugin.
 * Mirrors the inline types used in account-switcher.tsx and TeamTab.tsx.
 */
interface SidebarOrg {
  id: string;
  name: string;
  slug?: string | null;
  logo?: string | null;
}

interface SidebarMember {
  id: string;
  userId: string;
  role: string;
}

/**
 * Module-level singleton — Better Auth's React client wraps the
 * organization plugin in a Proxy whose property accesses return a fresh
 * reference, so capturing it inside the component body and using it as a
 * useEffect dep creates an infinite render loop. See TeamTab for the
 * full explanation.
 */
const sidebarOrgClient = (authClient as unknown as {
  organization: {
    list: () => Promise<{ data?: SidebarOrg[] }>;
    setActive: (opts: { organizationId: string }) => Promise<{ error?: { message?: string } }>;
    getFullOrganization: (opts?: { organizationId: string }) => Promise<{ data?: { id: string; members?: SidebarMember[] } | null }>;
  };
}).organization;

interface NavItem {
  key: string;
  href: string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  /** Nested items shown indented beneath this one (e.g. Apps under Projects). */
  children?: NavItem[];
}

interface NavSection {
  section?: string;   // i18n key under t.dashboard.nav.sections
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
  { key: "issues", href: "/issues", icon: ShieldAlert },
];

/** Build nav sections dynamically */
function getNavSections(isSaaS: boolean, selfHosted: boolean): NavSection[] {
  const settingsItems: NavItem[] = [
    { key: "backups", href: "/backups", icon: DatabaseBackup },
    { key: "settings", href: "/settings", icon: Settings },
  ];
  if (isSaaS) {
    settingsItems.push({ key: "billing", href: "/billing", icon: CreditCard });
  }

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

  return [
    { section: "main", items: MAIN_ITEMS },
    { section: "settings", items: settingsItems },
    { section: "infrastructure", items: infraItems },
  ].filter((s) => s.items.length > 0);
}

export function Sidebar() {
  const { user } = useAuth();
  const { selfHosted, deployMode, authMode, machineName } = usePlatform();
  const { connected: cloudConnected, cloudUser } = useCloud();
  const isDesktop = deployMode === "desktop";

  // The primary identity in the sidebar header is ALWAYS the local Better
  // Auth user (the "who am I on this self-hosted instance" - the operator-
  // of-record whose org, team, audit log, and permissions every other
  // surface in the dashboard is scoped to). A cloud connection is a
  // CREDENTIAL the local user HOLDS (used to mint namespace tokens, proxy
  // GitHub App, etc.) - not an identity replacement.
  //
  // The external SaaS profile (cloudUser.name / cloudUser.email) belongs in
  // Settings -> CloudConnection where it lives as a "Linked to Openship
  // Cloud as <email>" card. We surface it here only as a small secondary
  // hint line under the local identity when a cloud session is active, so
  // the operator can see WHICH external account is linked without ever
  // having the local user's name swapped out from under them.
  //
  // Fallback for the zero-auth desktop case (Electron build where no
  // Better Auth user exists yet, e.g. fresh install before onboarding):
  // fall back to machineName, NEVER to the cloud profile.
  const displayName =
    user?.name ||
    user?.email?.split("@")[0] ||
    (isDesktop ? (machineName || "Local User") : "");
  const displayEmail =
    user?.email ||
    (isDesktop ? "Desktop" : "");
  const cloudBadge = cloudConnected ? cloudUser : null;
  const displayInitial = displayName?.[0] ?? displayEmail?.[0] ?? "?";
  const isSaaS = !selfHosted || cloudConnected;
  const navSections = getNavSections(isSaaS, selfHosted);
  const pathname = usePathname();
  const router = useRouter();
  const { resolvedTheme, toggle } = useTheme();
  const { t } = useI18n();
  const [collapsed, setCollapsed] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [navCounts, setNavCounts] = useState<{ projects: number; apps: number } | null>(null);
  const [navCountsRevision, setNavCountsRevision] = useState(getSidebarNavCountsRevision);
  const countFor = (key: string): number | null => {
    if (!navCounts) return null;
    if (key === "projects") return navCounts.projects;
    if (key === "apps") return navCounts.apps;
    return null;
  };

  useEffect(() => subscribeSidebarNavCounts(() => {
    setNavCountsRevision(getSidebarNavCountsRevision());
  }), []);

  // Org switcher state. Lazy-loaded — `list()` and the active org fetch
  // only fire after the first popover open so the sidebar doesn't pay
  // for the round-trip on every page load. The role chip for the active
  // org is fetched alongside.
  const [orgsOpen, setOrgsOpen] = useState(false);
  const [orgs, setOrgs] = useState<SidebarOrg[]>([]);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [activeOrgRole, setActiveOrgRole] = useState<string | null>(null);
  const [orgRoles, setOrgRoles] = useState<Record<string, string>>({});
  const [orgsLoaded, setOrgsLoaded] = useState(false);
  const [switchingOrgId, setSwitchingOrgId] = useState<string | null>(null);

  // Fetch on mount so the trigger shows the current org name without
  // waiting for the user to click. Cheap (one /list call) and mirrors
  // the AccountSwitcher pattern.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [listRes, activeRes] = await Promise.all([
          sidebarOrgClient.list(),
          sidebarOrgClient.getFullOrganization().catch(() => ({ data: null })),
        ]);
        if (cancelled) return;
        const list = listRes.data ?? [];
        setOrgs(list);
        const aid = (activeRes.data as { id: string } | null)?.id ?? null;
        setActiveOrgId(aid);
        setActiveOrganizationId(aid);
        setOrgsLoaded(true);
        // Per-workspace role for EVERY row (not just the active one) so you can
        // tell which workspaces you own. One getFullOrganization per org;
        // failures just leave that row's chip off.
        try {
          const entries = await Promise.all(
            list.map(async (o) => {
              try {
                const full = await sidebarOrgClient.getFullOrganization({ organizationId: o.id });
                const me = full.data?.members?.find((m) => m.userId === user?.id);
                return [o.id, me?.role ?? null] as const;
              } catch {
                return [o.id, null] as const;
              }
            }),
          );
          if (cancelled) return;
          const map = Object.fromEntries(entries.filter(([, r]) => r)) as Record<string, string>;
          setOrgRoles(map);
          if (aid) setActiveOrgRole(map[aid] ?? null);
        } catch {
          /* role chips optional */
        }
      } catch {
        /* org switcher hidden when fetch fails */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user?.id]);

  // Nav counts — Projects & Apps only, from the same `projects/home` payload
  // both pages load. Apps are projects with `isApp` (catalog installs); the
  // Projects nav counts the REST (real projects), exactly mirroring what each
  // page renders — apps live only under Apps, never double-counted.
  //
  // Gated on `orgsLoaded`: the count fetch must run under the resolved active
  // org (the org effect above sets `setActiveOrganizationId` a round-trip
  // later). Firing on mount races that and can pull an extra project from the
  // wrong scope — the "2 real projects showed 3" bug. Re-runs on org switch.
  useEffect(() => {
    if (!orgsLoaded) return;
    let cancelled = false;
    projectsApi
      .getHome()
      .then((res) => {
        if (cancelled || !res?.success || !Array.isArray(res.projects)) return;
        // Distinct by id — the payload merges local + cloud, which can list the
        // same project twice; a dupe must not inflate the tally.
        const seen = new Set<string>();
        let projects = 0;
        let apps = 0;
        for (const p of res.projects) {
          const id = p?.id;
          if (id && seen.has(id)) continue;
          if (id) seen.add(id);
          if (p?.isApp) apps += 1;
          else projects += 1;
        }
        setNavCounts({ projects, apps });
      })
      .catch(() => {
        /* counts are optional chrome — silent on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [orgsLoaded, activeOrgId, navCountsRevision]);

  async function handleOrgSwitch(orgId: string) {
    if (orgId === activeOrgId) {
      setOrgsOpen(false);
      return;
    }
    setSwitchingOrgId(orgId);
    try {
      const res = await sidebarOrgClient.setActive({ organizationId: orgId });
      if (res.error) {
        setSwitchingOrgId(null);
        return;
      }
      setActiveOrganizationId(orgId);
      // Reload so every list endpoint re-fetches under the new scope.
      window.location.reload();
    } catch {
      setSwitchingOrgId(null);
    }
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      if (isDesktop && (window as any).desktop?.reset) {
        // Desktop: reset config and return to Electron onboarding
        await (window as any).desktop.reset();
        return;
      }
      await signOut();
      router.push("/login");
    } catch {
      setLoggingOut(false);
    }
  }

  const activeOrg =
    orgs.find((o) => o.id === activeOrgId) ?? orgs[0] ?? null;
  const showOrgSwitcher = orgsLoaded && !!activeOrg;

  const isActive = (href: string) =>
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(href + "/");

  const label = (key: string) =>
    (t.dashboard.nav as unknown as Record<string, string>)[key] ?? key;

  const sectionLabel = (key: string) =>
    (t.dashboard.nav.sections as unknown as Record<string, string>)[key] ?? key;

  return (
    <aside
      className={`my-3 ms-3 flex shrink-0 flex-col rounded-2xl border border-border/50 bg-card transition-[width] duration-200 overflow-hidden ${collapsed ? "w-[72px]" : "w-[260px]"
        }`}
    >
      {/* ── Header ───────────────────────────────────────────── */}
      <div className={`app-sidebar-header flex items-center px-5 py-6 ${collapsed ? "flex-col gap-3 pb-3" : "justify-between"}`}>
        <div className="flex items-center gap-2.5 min-w-0">
          <Logo size={26} className="shrink-0" />
          {!collapsed && (
            <span className="text-base font-semibold tracking-tight text-foreground truncate">
              {t.brand}
            </span>
          )}
        </div>

        {/* Controls */}
        <div className={`flex items-center ${collapsed ? "flex-col gap-1" : "gap-1"}`}>
          <button
            onClick={toggle}
            className="flex size-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
            aria-label={t.auth.toggleTheme}
            title={t.auth.toggleTheme}
          >
            {/* Icon shows the CURRENT theme; clicking cycles light → dim → dark. */}
            {resolvedTheme === "light" ? (
              <Sun className="size-4" />
            ) : resolvedTheme === "dim" ? (
              <SunMoon className="size-4" />
            ) : (
              <Moon className="size-4" />
            )}
          </button>
          <button
            type="button"
            onClick={() => setCollapsed((v) => !v)}
            aria-label={collapsed ? t.dashboard.sidebar.expand : t.dashboard.sidebar.collapse}
            className="flex size-8 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4 rtl:rotate-180" />
            ) : (
              <PanelLeftClose className="size-4 rtl:rotate-180" />
            )}
          </button>
        </div>
      </div>

      <div className="mx-3 h-px bg-border/60" />

      {/* ── Nav sections ────────────────────────────────────────── */}
      <div className="relative flex-1 min-h-0">
        <nav className="h-full overflow-y-auto px-3 pt-3 pb-12">
          {navSections.map(({ section, items }, si) => (
            <div key={section ?? si} className={si > 0 ? "mt-5" : undefined}>
              {!collapsed && section && (
                <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
                  {sectionLabel(section)}
                </p>
              )}
              {collapsed && si > 0 && <div className="my-3 mx-2 h-px bg-border/60" />}
              <div className="space-y-1">
                {items.map(({ key, href, icon: Icon }) => {
                  const active = isActive(href);
                  const count = countFor(key);
                  return (
                    <Link
                      key={key}
                      href={href}
                      title={collapsed ? label(key) : undefined}
                      className={`flex items-center rounded-xl px-3 py-2.5 text-[15px] font-medium transition-colors ${collapsed ? "justify-center" : "gap-3"
                        } ${active
                          ? "bg-foreground/[0.07] text-foreground"
                          : "text-muted-foreground hover:bg-foreground/[0.04] hover:text-foreground"
                        }`}
                    >
                      <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
                      {!collapsed && <span className="flex-1 truncate">{label(key)}</span>}
                      {/* Subtle right-aligned tally — Projects & Apps only, hidden
                          at 0 and when collapsed. Muted + tabular so it reads as
                          metadata, not a notification badge. */}
                      {!collapsed && count != null && count > 0 && (
                        <span className="shrink-0 text-[13px] tabular-nums text-muted-foreground/45">
                          {count}
                        </span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>
        {/* Fade the bottom of the scroll into the sidebar bg so the list ends
            smoothly behind the CTA instead of cutting off hard. */}
        {/* Fade masks nav overflow scrolling under the button. --card is a
            white-based translucent token, so the default fades toward
            transparent-WHITE — fine on light, but a light sheen on the mid-gray
            dim card and invisible on the near-black dark card. Use the solid
            card hue in dim AND dark so the ramp stays the card's own color. */}
        {/* Scroll fade. ONE gradient for every theme: --th-card-on-page is the
            opaque composite of this card over the page, so the fade starts at
            exactly the surface behind it. The per-theme variants this replaces
            faded from --th-card-bg-solid (the MODAL surface) — #060606 in dark
            against a real sidebar of #0d0d0d, i.e. a black band. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-[var(--th-card-on-page)] to-transparent" />
      </div>

      {/* ── New Project ─────────────────────────────────────── */}
      <div className="px-3 pb-2">
        <Link
          href="/library"
          title={collapsed ? label("new-project") : undefined}
          className={`relative flex items-center justify-center gap-2.5 rounded-xl px-3 py-2.5 text-sm font-semibold transition-all overflow-hidden ${"bg-gradient-to-r from-violet-500/90 via-primary/90 to-blue-500/90 text-white shadow-sm shadow-primary/20 hover:shadow-md hover:shadow-primary/30 hover:brightness-110 dark:from-amber-400/90! dark:via-orange-500/90! dark:to-rose-500/90! dark:shadow-orange-500/20 dark:hover:shadow-orange-500/30 dim:from-[hsl(86_84%_74%)]! dim:via-[hsl(82_80%_64%)]! dim:to-[hsl(74_74%_54%)]! dim:text-[#0c1206]! dim:shadow-lime-400/25 dim:hover:shadow-lime-400/40"
            }`}
        >
          <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_50%,rgba(255,255,255,0.15),transparent_70%)]" />
          <Plus className="relative size-4" strokeWidth={2.5} />
          {!collapsed && <span className="relative">{label("new-project")}</span>}
        </Link>
      </div>

      {/* ── Account / Org switcher ──────────────────────────── */}
      <div className="px-3 pb-4 pt-1">
        <div className="mx-2 mb-3 h-px bg-border/60" />
        {!collapsed && (
          <p className="mb-2 px-2 text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            {t.dashboard.nav.sections.account}
          </p>
        )}

        {showOrgSwitcher ? (
          <DismissiblePopover
            open={orgsOpen}
            onOpenChange={setOrgsOpen}
            className="relative"
          >
            {/* Trigger — current org + chevron, Cloudflare-style */}
            <button
              type="button"
              onClick={() => setOrgsOpen((v) => !v)}
              className={`group flex w-full items-center rounded-xl px-2 py-2 text-start transition-colors hover:bg-foreground/[0.06] ${collapsed ? "justify-center" : "gap-3"
                }`}
              aria-haspopup="dialog"
              aria-expanded={orgsOpen}
              title={collapsed ? activeOrg?.name : undefined}
            >
              {/* Org avatar / initial */}
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-foreground/[0.08] text-sm font-semibold uppercase text-foreground">
                {activeOrg?.name?.[0] ?? <Building2 className="size-4" />}
              </div>

              {!collapsed && (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-semibold leading-tight text-foreground">
                      {activeOrg?.name ?? t.chrome.sidebar.workspaceFallback}
                    </p>
                    <p className="truncate text-[12px] leading-tight text-muted-foreground">
                      {orgs.length > 1
                        ? interpolate(t.chrome.sidebar.workspacesCount, { count: String(orgs.length) })
                        : displayEmail}
                    </p>
                  </div>
                  <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
                </>
              )}
            </button>

            {/* Popover — shown to the side when collapsed, above when expanded */}
            {orgsOpen && (
              <div
                className={`absolute z-50 overflow-hidden rounded-2xl border border-border/50 bg-popover shadow-xl shadow-black/[0.08] ${collapsed
                    ? "start-full bottom-0 ms-2 w-72"
                    : "start-0 end-0 bottom-full mb-2"
                  }`}
              >
                {/* Heading */}
                <div className="px-3 pt-3 pb-2">
                  <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground/70">
                    {t.chrome.sidebar.switchOrganization}
                  </p>
                </div>

                {/* Org list */}
                <div className="max-h-64 overflow-y-auto pb-1">
                  {orgs.map((o) => {
                    const isCurrent = o.id === activeOrgId;
                    const isSwitching = switchingOrgId === o.id;
                    return (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => handleOrgSwitch(o.id)}
                        disabled={!!switchingOrgId}
                        className={`flex w-full items-center gap-2.5 px-3 py-2 text-start transition-colors hover:bg-foreground/[0.05] disabled:opacity-60 ${isCurrent ? "bg-foreground/[0.03]" : ""
                          }`}
                      >
                        <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-foreground/[0.08] text-[12px] font-semibold uppercase text-foreground">
                          {o.name?.[0] ?? <Building2 className="size-3.5" />}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13px] font-medium leading-tight text-foreground">
                            {o.name}
                          </p>
                          <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11px] leading-tight text-muted-foreground">
                            {isCurrent && (
                              <span className="rounded-md bg-foreground/[0.06] px-1.5 py-0.5 font-medium uppercase tracking-wide text-[10px] text-muted-foreground">
                                {t.chrome.sidebar.current}
                              </span>
                            )}
                            {user?.id && o.id === `org_${user.id}` && (
                              <span className="text-muted-foreground/80">{t.chrome.sidebar.personal}</span>
                            )}
                            {orgRoles[o.id] && (
                              <span className="capitalize text-muted-foreground/80">{orgRoles[o.id]}</span>
                            )}
                          </p>
                        </div>
                        {isCurrent && !isSwitching && (
                          <Check className="size-4 shrink-0 text-primary" />
                        )}
                        {isSwitching && (
                          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                        )}
                      </button>
                    );
                  })}
                </div>

                {/* Footer separator + signed-in-as + sign out */}
                <div className="border-t border-border/40 px-2 py-2">
                  <div className="flex items-center gap-2.5 rounded-xl px-2 py-1.5">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-[11px] font-semibold uppercase text-foreground">
                      {displayInitial}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-medium leading-tight text-foreground">
                        {displayName}
                      </p>
                      <p className="truncate text-[11px] leading-tight text-muted-foreground">
                        {displayEmail}
                      </p>
                      {cloudBadge?.email && (
                        <p
                          className="truncate text-[10px] leading-tight text-muted-foreground/70"
                          title={interpolate(t.chrome.sidebar.linkedToCloud, { email: cloudBadge.email })}
                        >
                          {interpolate(t.chrome.sidebar.cloudLabel, { email: cloudBadge.email })}
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleLogout}
                    disabled={loggingOut}
                    className="mt-1 flex w-full items-center gap-2 rounded-xl px-2 py-2 text-[13px] font-medium text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
                  >
                    {loggingOut ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <LogOut className="size-4" />
                    )}
                    {isDesktop ? t.chrome.sidebar.backToSetup : t.dashboard.user.logout}
                  </button>
                </div>
              </div>
            )}
          </DismissiblePopover>
        ) : (
          /* Fallback: no org context (desktop / pre-org-bootstrap / fetch
             failure). Keep the original avatar + email + sign-out row so
             the operator can still log out. */
          <>
            <div
              className={`flex items-center rounded-xl px-2 py-2 ${collapsed ? "justify-center" : "gap-3"
                }`}
            >
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground/[0.08] text-sm font-semibold uppercase text-foreground">
                {displayInitial}
              </div>

              {!collapsed && (
                <>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[14px] font-medium leading-tight text-foreground">
                      {displayName}
                    </p>
                    <p className="truncate text-[12px] leading-tight text-muted-foreground">
                      {displayEmail}
                    </p>
                    {cloudBadge?.email && (
                      <p
                        className="truncate text-[11px] leading-tight text-muted-foreground/70"
                        title={interpolate(t.chrome.sidebar.linkedToCloud, { email: cloudBadge.email })}
                      >
                        {interpolate(t.chrome.sidebar.cloudLabel, { email: cloudBadge.email })}
                      </p>
                    )}
                  </div>
                  <button
                    onClick={handleLogout}
                    disabled={loggingOut}
                    className="flex size-8 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
                    aria-label={isDesktop ? t.chrome.sidebar.backToSetup : t.dashboard.user.logout}
                    title={isDesktop ? t.chrome.sidebar.backToSetup : t.dashboard.user.logout}
                  >
                    {loggingOut ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <LogOut className="size-4" />
                    )}
                  </button>
                </>
              )}
            </div>

            {collapsed && (
              <button
                onClick={handleLogout}
                disabled={loggingOut}
                className="mt-2 flex w-full items-center justify-center rounded-xl py-2.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
                title={isDesktop ? t.chrome.sidebar.backToSetup : t.dashboard.user.logout}
              >
                {loggingOut ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <LogOut className="size-4" />
                )}
              </button>
            )}
          </>
        )}

        {/* Collapsed: surface logout when switcher is shown but popover
            closed, so users without a pointer-friendly path still have a
            shortcut. The switcher itself handles the trigger spot. */}
        {collapsed && showOrgSwitcher && !orgsOpen && (
          <button
            onClick={handleLogout}
            disabled={loggingOut}
            className="mt-2 flex w-full items-center justify-center rounded-xl py-2.5 text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground disabled:opacity-50"
            title={isDesktop ? t.chrome.sidebar.backToSetup : t.dashboard.user.logout}
          >
            {loggingOut ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogOut className="size-4" />
            )}
          </button>
        )}
      </div>
    </aside>
  );
}

