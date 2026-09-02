import { describe, expect, it } from "vitest";

import { MAIL_TAB_KEYS } from "./mail-tabs";
import { baseDictionary } from "../i18n";
import {
  getMailNavSections,
  getNavSections,
  isNavItemActive,
  mailTabHref,
  webmailHref,
  type MailNavInput,
  type NavItem,
  type NavSection,
} from "./sidebar-nav";

/**
 * Three things are pinned here.
 *
 * One: the mail section is a function of mail state, in lockstep with
 * `resolveMailView()` (`emails/_lib/view-gate.ts`). Drift either way is a rail of
 * links that all land somewhere else — every tab on a box with no mail server, or
 * a lone "Set up mail" on a working one.
 *
 * Two: every label key the rail emits actually exists in the English dictionary.
 * The rail resolves labels by key at render time (`sidebar.tsx`), so a typo
 * doesn't fail a build or a type check — it silently renders the raw key, and
 * `?? key` means even the fallback looks intentional.
 *
 * Three: every tab is still reachable after the grouping. They're spread over
 * three headings now, and a tab dropped from one group without being added to
 * another would just quietly vanish from the rail.
 */

const keysOf = (s?: NavSection) => (s?.items ?? []).map((i) => i.key);
const sectionsOf = (s: NavSection[]) => s.map((x) => x.section);
const find = (s: NavSection[], section: string) => s.find((x) => x.section === section);
/** The tail group (Issues + Settings). */
const tailOf = (s: NavSection[]) => s.find((x) => x.section === "system");

const mailAt = (input: Partial<MailNavInput> = {}): NavSection[] =>
  getMailNavSections({
    loaded: true,
    serverCount: 1,
    activeServerId: "srv1",
    activeCompleted: true,
    selfHosted: true,
    ...input,
  });

/**
 * Not a hand-kept copy: the panel renders its tab bar from this same list
 * (`./mail-tabs`), so a section added there and forgotten here can't
 * make the "every tab is reachable" test below pass by asking about nine of ten.
 */
const ALL_TABS: readonly string[] = MAIL_TAB_KEYS;

describe("getNavSections (the platform rail)", () => {
  it("is unchanged by mail mode: main + infrastructure + settings", () => {
    const s = getNavSections(false, true);
    expect(sectionsOf(s)).toEqual(["main", "infrastructure", "settings"]);
    expect(keysOf(find(s, "main"))).toEqual([
      "home",
      "projects",
      "deployments",
      "issues",
    ]);
    expect(keysOf(find(s, "infrastructure"))).toEqual(["servers", "emails", "jobs"]);
    expect(keysOf(find(s, "settings"))).toEqual(["backups", "settings", "audit"]);
  });

  it("adds Billing on the SaaS and drops the infrastructure section there", () => {
    const s = getNavSections(true, false);
    expect(keysOf(find(s, "settings"))).toEqual(["backups", "settings", "billing", "audit"]);
    // Empty sections are filtered out, not rendered as a bare heading.
    expect(find(s, "infrastructure")).toBeUndefined();
  });

  it("keeps Billing at the very bottom, below Servers, on a cloud-linked self-hosted box", () => {
    // isSaaS goes true the moment a self-hosted install links a cloud account, which
    // is the case that put Billing above Servers. The invariant is that Billing does not
    // OUTRANK the infrastructure — every host row must precede it.
    const s = getNavSections(true, true);
    const keys = s.flatMap((x) => keysOf(x));
    for (const host of ["servers", "emails", "jobs"]) {
      expect(keys.indexOf(host), host).toBeLessThan(keys.indexOf("billing"));
    }
    // Only the audit log follows it. That is a read-only review surface, consulted after
    // the fact and never on the way to a task, so it is deliberately the last row — it
    // cannot outrank anything by sitting there.
    expect(keys.at(-1)).toBe("audit");
    expect(keys.indexOf("billing")).toBe(keys.length - 2);
  });

  it("keeps /emails in the platform rail", () => {
    // Mail mode promotes the tabs, it doesn't move the page: an operator on the
    // full platform still reaches mail the way they always did.
    expect(keysOf(find(getNavSections(false, true), "infrastructure"))).toContain("emails");
  });
});

describe("getMailNavSections (the Openship Mail rail)", () => {
  it("shows one entry pointing at the real route before the list loads", () => {
    const mail = find(mailAt({ loaded: false }), "mail");
    expect(keysOf(mail)).toEqual(["emails"]);
    expect(mail?.items[0]?.href).toBe("/emails");
    // No `tab`: the pre-fetch entry must not fight the URL for the active state.
    expect(mail?.items[0]?.tab).toBeUndefined();
  });

  it("shows only Set up mail with no mail servers", () => {
    const mail = find(mailAt({ serverCount: 0, activeServerId: null }), "mail");
    expect(keysOf(mail)).toEqual(["mailSetup"]);
    expect(mail?.items[0]?.href).toBe("/emails");
  });

  it("shows only Set up mail when servers exist but none is scoped", () => {
    // serverCount > 0 with no activeServerId is the pre-selection window; the ten
    // tabs would all point at /emails?tab=… with no server, which the page can't
    // resolve.
    expect(keysOf(find(mailAt({ activeServerId: null }), "mail"))).toEqual(["mailSetup"]);
  });

  it("shows only Setup progress while the active server is unfinished", () => {
    const mail = find(mailAt({ activeCompleted: false }), "mail");
    expect(keysOf(mail)).toEqual(["mailSetupProgress"]);
    // Scoped but tab-less: /emails renders the wizard for an incomplete server.
    expect(mail?.items[0]?.href).toBe("/emails?serverId=srv1");
  });

  it("splits every tab across three headings once the server is completed", () => {
    const s = mailAt();
    expect(keysOf(find(s, "mail"))).toEqual([
      "overview",
      "domains",
      "mailboxes",
      "aliases",
      "notifications",
      "webmail",
    ]);
    // Sending leads — it's the decision the other two check. Same order as the tab
    // bar's delivery run in ./mail-tabs. Sending a test email used to
    // close this group; it's an action inside Sending now.
    expect(keysOf(find(s, "delivery"))).toEqual(["sending", "dns", "health"]);
    // Backups + Advanced ride the infrastructure group, below the host rows.
    expect(keysOf(find(s, "infrastructure"))).toEqual(["servers", "jobs", "backup", "advanced"]);
  });

  it("still reaches every tab, and every one is a ?tab= link", () => {
    const s = mailAt();
    const tabItems = s.flatMap((x) => x.items).filter((i) => i.labelSource === "mailTab");
    expect(tabItems.map((i) => i.key).sort()).toEqual([...ALL_TABS].sort());
    for (const item of tabItems) {
      expect(item.tab).toBe(item.key);
      expect(item.href).toBe(`/emails?serverId=srv1&tab=${item.key}`);
    }
  });

  it("claims / for the mail section in every mail state", () => {
    // Mail view renders the console at / as well ((dashboard)/page.tsx), and /
    // is where login lands. Links still point at /emails — this is the highlight
    // only, so an operator does not arrive on a rail with nothing lit.
    const states: Array<Partial<MailNavInput>> = [
      {},
      { loaded: false },
      { serverCount: 0, activeServerId: null },
      { activeCompleted: false },
    ];
    for (const state of states) {
      const mail = find(mailAt(state), "mail");
      // Webmail is exempt: / renders the console, not the webmail resolver, so a
      // claim there would light two entries on the home page.
      for (const item of (mail?.items ?? []).filter((i) => i.key !== "webmail")) {
        expect(item.alsoAt, `${item.key} does not claim /`).toContain("/");
        expect(item.href.startsWith("/emails")).toBe(true);
      }
    }
  });

  it("does not hand / to the host or settings rows", () => {
    // Servers/Jobs/Issues/Settings are ordinary routes in mail view; claiming /
    // would light two entries at once on the home page.
    const s = mailAt();
    const byKey = (k: string) => s.flatMap((x) => x.items).find((i) => i.key === k);
    for (const key of ["servers", "jobs", "issues", "settings"]) {
      expect(byKey(key)?.alsoAt, key).toBeUndefined();
    }
  });

  it("puts Servers above the mail server's own maintenance rows", () => {
    // The point of the grouping: ten flat mail entries buried Servers at row 11.
    const keys = mailAt().flatMap((x) => keysOf(x));
    expect(keys.indexOf("servers")).toBeLessThan(keys.indexOf("backup"));
    // Index-pinned on purpose, and it moves whenever a mail tab is added or removed
    // ahead of the infrastructure group — Notifications (after Aliases) took it from
    // 9 to 10, and folding Test into Sending gave one back.
    expect(keys.indexOf("servers")).toBe(9);
  });

  describe("Webmail — the one mail entry that is a project, not a tab", () => {
    it("closes the MAIL group once the server is installed", () => {
      const mail = find(mailAt(), "mail");
      const webmail = mail?.items.at(-1);
      expect(webmail?.key).toBe("webmail");
      expect(webmail?.href).toBe("/emails/webmail?serverId=srv1");
      // Not a ?tab= item, and it must not claim / (the console lives there).
      expect(webmail?.tab).toBeUndefined();
      expect(webmail?.labelSource).toBeUndefined();
      expect(webmail?.alsoAt).toBeUndefined();
    });

    it("stays out of the rail until there is a mail server to serve", () => {
      // Offering to deploy a webmail client for a box that doesn't serve mail yet
      // is a detour; the setup entry IS the action in those states.
      for (const state of [
        { loaded: false },
        { serverCount: 0, activeServerId: null },
        { activeCompleted: false },
      ] as Array<Partial<MailNavInput>>) {
        expect(mailAt(state).flatMap((s) => keysOf(s))).not.toContain("webmail");
      }
    });

    it("url-encodes the server id, and omits the param when there isn't one", () => {
      expect(webmailHref("a b/c")).toBe("/emails/webmail?serverId=a%20b%2Fc");
      expect(webmailHref(null)).toBe("/emails/webmail");
    });
  });

  it("carries the server id through, url-encoded", () => {
    const mail = find(mailAt({ activeServerId: "a b/c" }), "mail");
    expect(mail?.items[0]?.href).toBe("/emails?serverId=a+b%2Fc&tab=overview");
    expect(find(mailAt({ activeServerId: "a b/c", activeCompleted: false }), "mail")?.items[0]?.href)
      .toBe("/emails?serverId=a%20b%2Fc");
  });

  it("always offers Issues and Settings under System", () => {
    expect(sectionsOf(mailAt())).toEqual(["mail", "delivery", "infrastructure", "system"]);
    expect(keysOf(tailOf(mailAt()))).toEqual(["issues", "settings"]);
    // Both survive every mail state, including a box with no mail server at all.
    expect(keysOf(tailOf(mailAt({ serverCount: 0, activeServerId: null })))).toEqual([
      "issues",
      "settings",
    ]);
  });

  it("adds Servers and Jobs only self-hosted", () => {
    expect(keysOf(find(mailAt({ selfHosted: false }), "infrastructure"))).toEqual([
      "backup",
      "advanced",
    ]);
  });

  it("shows no empty headings before the ten sections exist", () => {
    // Delivery has nothing to list until the server is installed, and on a cloud
    // box neither does Infrastructure — a bare heading over no rows reads as a
    // broken rail.
    expect(sectionsOf(mailAt({ loaded: false }))).toEqual(["mail", "infrastructure", "system"]);
    expect(sectionsOf(mailAt({ loaded: false, selfHosted: false }))).toEqual(["mail", "system"]);
  });

  it("never puts the platform pages in the mail rail", () => {
    // Hidden, not gated — /projects still loads by URL (the webmail project lives
    // there). This asserts the hiding half only.
    const keys = mailAt().flatMap((s) => keysOf(s));
    for (const gone of ["home", "projects", "apps", "deployments", "backups", "billing"]) {
      expect(keys).not.toContain(gone);
    }
  });
});

describe("mailTabHref", () => {
  it("omits serverId when there isn't one rather than emitting an empty param", () => {
    expect(mailTabHref(null, "domains")).toBe("/emails?tab=domains");
    expect(mailTabHref("srv1", "domains")).toBe("/emails?serverId=srv1&tab=domains");
  });
});

describe("isNavItemActive", () => {
  const tabItem = (tab: string): NavItem => ({
    key: tab,
    href: mailTabHref("srv1", tab),
    icon: (() => null) as unknown as NavItem["icon"],
    tab,
  });
  const pathItem = (href: string): NavItem => ({
    key: href,
    href,
    icon: (() => null) as unknown as NavItem["icon"],
  });

  it("matches a tab item on the query, not the path", () => {
    expect(isNavItemActive(tabItem("mailboxes"), "/emails", "mailboxes")).toBe(true);
    expect(isNavItemActive(tabItem("mailboxes"), "/emails", "domains")).toBe(false);
    // Same tab, different page: the query alone must not light it up.
    expect(isNavItemActive(tabItem("mailboxes"), "/settings", "mailboxes")).toBe(false);
  });

  it("gives Overview the bare /emails url", () => {
    // /emails with no ?tab= renders Overview, so exactly one entry is active
    // there — the alternative is a rail with nothing highlighted on first land.
    expect(isNavItemActive(tabItem("overview"), "/emails", null)).toBe(true);
    expect(isNavItemActive(tabItem("domains"), "/emails", null)).toBe(false);
  });

  it("lights the section a retired tab resolved to", () => {
    // `?tab=inbound` and `?tab=test` are still in bookmarks and in history. The
    // panel renders the section that absorbed them, so an exact compare here would
    // show that section with nothing lit in the rail — the one half of the rename
    // no test and no type would have caught.
    expect(isNavItemActive(tabItem("notifications"), "/emails", "inbound")).toBe(true);
    expect(isNavItemActive(tabItem("sending"), "/emails", "test")).toBe(true);
    // And a retired key lights ONLY its successor: not the section it named before,
    // and not Overview, which owns the tab-less URL.
    expect(isNavItemActive(tabItem("overview"), "/emails", "inbound")).toBe(false);
    expect(isNavItemActive(tabItem("health"), "/emails", "test")).toBe(false);
    // An unknown tab falls back to Overview, matching what the panel renders.
    expect(isNavItemActive(tabItem("overview"), "/emails", "nope")).toBe(true);
  });

  it("matches non-tab items by path prefix, so detail pages keep the parent lit", () => {
    expect(isNavItemActive(pathItem("/servers"), "/servers", null)).toBe(true);
    expect(isNavItemActive(pathItem("/servers"), "/servers/3/security", null)).toBe(true);
    // Prefix, not substring: a sibling route that merely starts with the name.
    expect(isNavItemActive(pathItem("/servers"), "/servers-legacy", null)).toBe(false);
    // A stray ?tab= on a path item changes nothing.
    expect(isNavItemActive(pathItem("/settings"), "/settings", "mailboxes")).toBe(true);
  });

  it("keeps the webmail route and the mail tabs from lighting each other", () => {
    // Two entries share the /emails prefix but nothing else: Webmail is a path
    // item at /emails/webmail, the tabs are query items at /emails.
    const webmail = pathItem("/emails/webmail?serverId=srv1");
    expect(isNavItemActive(webmail, "/emails/webmail", null)).toBe(true);
    expect(isNavItemActive(webmail, "/emails", null)).toBe(false);
    expect(isNavItemActive({ ...tabItem("overview"), alsoAt: ["/"] }, "/emails/webmail", null))
      .toBe(false);
  });

  it("keeps Home from matching every route", () => {
    expect(isNavItemActive(pathItem("/"), "/", null)).toBe(true);
    expect(isNavItemActive(pathItem("/"), "/projects", null)).toBe(false);
  });

  describe("alsoAt — the console's second home at /", () => {
    const alsoAtRoot = <T extends NavItem>(item: T): T => ({ ...item, alsoAt: ["/"] });

    it("lights the tab a query asks for, on / as much as on /emails", () => {
      expect(isNavItemActive(alsoAtRoot(tabItem("overview")), "/", null)).toBe(true);
      expect(isNavItemActive(alsoAtRoot(tabItem("domains")), "/", null)).toBe(false);
      // The page keeps ?tab= working at / (the rail writes /emails links, but the
      // console's own url handling does not change with the pathname).
      expect(isNavItemActive(alsoAtRoot(tabItem("domains")), "/", "domains")).toBe(true);
      expect(isNavItemActive(alsoAtRoot(tabItem("overview")), "/", "domains")).toBe(false);
    });

    it("lights a path item on / without giving it every route", () => {
      expect(isNavItemActive(alsoAtRoot(pathItem("/emails")), "/", null)).toBe(true);
      expect(isNavItemActive(alsoAtRoot(pathItem("/emails")), "/emails", null)).toBe(true);
      expect(isNavItemActive(alsoAtRoot(pathItem("/emails")), "/projects", null)).toBe(false);
    });

    it("changes nothing for items that do not claim /", () => {
      expect(isNavItemActive(tabItem("overview"), "/", null)).toBe(false);
      expect(isNavItemActive(pathItem("/servers"), "/", null)).toBe(false);
    });
  });
});

describe("every rail label resolves in the English dictionary", () => {
  const nav = baseDictionary.dashboard.nav as unknown as Record<string, unknown>;
  const tabs = baseDictionary.emailsAdmin.panel.tabs as unknown as Record<string, unknown>;
  const label = (item: NavItem) =>
    item.labelSource === "mailTab" ? tabs[item.key] : nav[item.key];

  const all: NavSection[] = [
    ...getNavSections(true, true),
    ...getNavSections(false, false),
    ...mailAt(),
    ...mailAt({ loaded: false }),
    ...mailAt({ serverCount: 0, activeServerId: null }),
    ...mailAt({ activeCompleted: false }),
  ];

  it("resolves every item label", () => {
    for (const section of all) {
      for (const item of section.items) {
        expect(label(item), `missing label for ${item.labelSource ?? "nav"}.${item.key}`)
          .toEqual(expect.any(String));
      }
    }
  });

  it("resolves every section heading", () => {
    const sections = baseDictionary.dashboard.nav.sections as unknown as Record<string, unknown>;
    // Every group carries one. sidebar.tsx renders a section without `section` as a
    // bare gap, which reads as an unfinished rail rather than a deliberate break —
    // so the absence is asserted here, not just the lookup.
    for (const section of all) {
      expect(section.section, "a nav section is missing its heading key").toEqual(
        expect.any(String),
      );
      expect(sections[section.section as string], `missing t.dashboard.nav.sections.${section.section}`)
        .toEqual(expect.any(String));
    }
  });

  it("resolves the two rail CTAs", () => {
    // sidebar.tsx swaps the CTA by view: "New Project" → /library on the platform,
    // "Add mailbox" → ?tab=mailboxes in mail mode.
    expect(nav["new-project"]).toEqual(expect.any(String));
    expect(nav.addMailbox).toEqual(expect.any(String));
  });
});
