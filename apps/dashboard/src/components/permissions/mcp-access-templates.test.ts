import { describe, expect, it } from "vitest";
import {
  ACCESS_LEVELS,
  LEVEL_PERMISSIONS,
  PROJECT_CREATE_GRANT,
  applyTemplate,
  authorizeBlockedReason,
  capabilityDigest,
  dropRejectedGrant,
  grantableTypes,
  hasCreateCapability,
  isUnscopedTemplate,
  labelKey,
  levelOf,
  mergePickerGrants,
  pickerGrants,
  readOnlyContradictions,
  reduceSelection,
  removeGrant,
  sameGrantSet,
  setCreateCapability,
  summaryGroups,
  summaryRows,
  templateGrants,
  wireGrants,
  wouldSilentlyGrantEverything,
  type AccessSelection,
} from "./mcp-access-templates";
import type { PickerGrant } from "@/lib/api";

const CTX = { githubAccounts: ["acme", "hydra"] };
const NO_GH = { githubAccounts: [] };

const project = (id: string, ...permissions: PickerGrant["permissions"]): PickerGrant => ({
  resourceType: "project",
  resourceId: id,
  permissions,
});
const ghOrg = (login: string, ...permissions: PickerGrant["permissions"]): PickerGrant => ({
  resourceType: "github_installation",
  resourceId: login,
  permissions,
});
const server = (id: string, ...permissions: PickerGrant["permissions"]): PickerGrant => ({
  resourceType: "server",
  resourceId: id,
  permissions,
});

const sel = (over: Partial<AccessSelection> = {}): AccessSelection => ({
  template: "custom",
  grants: [],
  readOnly: false,
  ...over,
});

describe("templateGrants", () => {
  it("the default is create-projects + read on every grantable GitHub account", () => {
    expect(templateGrants("agent", CTX)).toEqual([
      PROJECT_CREATE_GRANT,
      ghOrg("acme", "read"),
      ghOrg("hydra", "read"),
    ]);
  });

  it("degrades to create-only when GitHub isn't connected or its accounts are unavailable", () => {
    expect(templateGrants("agent", NO_GH)).toEqual([PROJECT_CREATE_GRANT]);
  });

  it("'existing projects' seeds NO projects — pre-selecting the org would be a mass over-grant", () => {
    const grants = templateGrants("existing", CTX);
    expect(grants.some((g) => g.resourceType === "project")).toBe(false);
    // GitHub read is still seeded: redeploying a git-linked project asserts repo read.
    expect(grants).toEqual([ghOrg("acme", "read"), ghOrg("hydra", "read")]);
  });

  it("never emits a project wildcard with anything but create — the server 400s on that", () => {
    for (const id of ["agent", "existing", "readOnly", "full", "custom"] as const) {
      for (const g of templateGrants(id, CTX)) {
        if (g.resourceType === "project" && g.resourceId === "*") {
          expect(g.permissions).toEqual(["create"]);
        }
      }
    }
  });

  it("full and read-only send no grants at all", () => {
    expect(templateGrants("full", CTX)).toEqual([]);
    expect(templateGrants("readOnly", CTX)).toEqual([]);
    expect(isUnscopedTemplate("full")).toBe(true);
    expect(isUnscopedTemplate("readOnly")).toBe(true);
    expect(isUnscopedTemplate("agent")).toBe(false);
    expect(isUnscopedTemplate("existing")).toBe(false);
    expect(isUnscopedTemplate("custom")).toBe(false);
  });
});

describe("grantableTypes", () => {
  it("omits billing and audit — a scoped grant on them authorizes nothing", () => {
    for (const selfHosted of [true, false]) {
      const types = grantableTypes(selfHosted);
      expect(types).not.toContain("billing");
      expect(types).not.toContain("audit");
      expect(types).toContain("project");
      expect(types).toContain("github_installation");
    }
  });

  it("offers servers and mail servers only self-hosted", () => {
    expect(grantableTypes(true)).toContain("server");
    expect(grantableTypes(true)).toContain("mail_server");
    expect(grantableTypes(false)).not.toContain("server");
    expect(grantableTypes(false)).not.toContain("mail_server");
  });
});

describe("access levels", () => {
  it("are cumulative, so the stored array always matches the level shown", () => {
    expect(LEVEL_PERMISSIONS.view).toEqual(["read"]);
    expect(LEVEL_PERMISSIONS.manage).toEqual(["read", "write"]);
    expect(LEVEL_PERMISSIONS.full).toEqual(["read", "write", "admin"]);
    for (const level of ACCESS_LEVELS) {
      expect(levelOf(LEVEL_PERMISSIONS[level])).toBe(level);
    }
  });

  it("reads a level off any permission array the server would treat the same way", () => {
    expect(levelOf(["read"])).toBe("view");
    expect(levelOf(["write"])).toBe("manage"); // write ⇐ implies read server-side
    expect(levelOf(["admin"])).toBe("full");
    expect(levelOf([])).toBe("view");
  });

});

describe("applyTemplate", () => {
  const edited = sel({ grants: [project("p1", "read", "write")], readOnly: true });

  it("picking a preset replaces the grants and resets read-only", () => {
    expect(applyTemplate("agent", edited, CTX)).toEqual({
      template: "agent",
      grants: templateGrants("agent", CTX),
      readOnly: false,
    });
  });

  it("picking Custom keeps the grants the user already has", () => {
    expect(applyTemplate("custom", edited, CTX)).toEqual({ ...edited, template: "custom" });
  });

  it("switching to an unscoped template RETAINS the grants but stops sending them", () => {
    const scoped = sel({ template: "agent", grants: templateGrants("agent", CTX) });
    const full = applyTemplate("full", scoped, CTX);
    expect(full.template).toBe("full");
    expect(full.grants).toEqual(scoped.grants); // retained → switching back is lossless
    expect(wireGrants(full)).toEqual([]); // but never sent
    expect(wireGrants(applyTemplate("custom", full, CTX))).toEqual(scoped.grants);
  });
});

describe("wireGrants / wouldSilentlyGrantEverything", () => {
  it("sends nothing for the unscoped templates whatever is retained", () => {
    expect(wireGrants(sel({ template: "full", grants: [project("p1", "read")] }))).toEqual([]);
    expect(
      wireGrants(sel({ template: "readOnly", grants: [project("p1", "read")], readOnly: true })),
    ).toEqual([]);
  });

  it("drops rows whose permissions were cleared", () => {
    expect(wireGrants(sel({ grants: [project("p1"), project("p2", "read")] }))).toEqual([
      project("p2", "read"),
    ]);
  });

  it("flags the one state that would mint an unscoped binding by accident", () => {
    expect(wouldSilentlyGrantEverything(sel({ template: "custom", grants: [] }))).toBe(true);
    expect(wouldSilentlyGrantEverything(sel({ template: "custom", grants: [project("p1")] }))).toBe(true);
    expect(wouldSilentlyGrantEverything(sel({ template: "full", grants: [] }))).toBe(false);
    expect(
      wouldSilentlyGrantEverything(sel({ template: "agent", grants: [PROJECT_CREATE_GRANT] })),
    ).toBe(false);
  });
});

describe("reduceSelection — relabelling", () => {
  const agent = sel({ template: "agent", grants: templateGrants("agent", CTX) });

  it("editing the default template's grants relabels it", () => {
    const next = reduceSelection(agent, { type: "setCreate", on: false }, CTX);
    // create removed, only seeded github accounts left → that IS "existing projects"
    expect(next.template).toBe("existing");
    expect(hasCreateCapability(next.grants)).toBe(false);
  });

  it("reverting the edit exactly restores the template name", () => {
    const off = reduceSelection(agent, { type: "setCreate", on: false }, CTX);
    const backOn = reduceSelection(off, { type: "setCreate", on: true }, CTX);
    expect(backOn.template).toBe("agent");
    expect(sameGrantSet(backOn.grants, agent.grants)).toBe(true);
  });

  it("'existing projects' keeps its name while the user picks projects", () => {
    const existing = sel({ template: "existing", grants: templateGrants("existing", CTX) });
    const picked = reduceSelection(
      existing,
      { type: "pickerChange", grants: [...templateGrants("existing", CTX), project("p1", "read", "write")] },
      CTX,
    );
    expect(picked.template).toBe("existing");
    const two = reduceSelection(
      picked,
      { type: "pickerChange", grants: [...picked.grants, project("p2", "read")] },
      CTX,
    );
    expect(two.template).toBe("existing");
  });

  it("adding something outside its shape makes 'existing projects' custom", () => {
    const existing = sel({ template: "existing", grants: templateGrants("existing", CTX) });
    const withServer = reduceSelection(
      existing,
      { type: "pickerChange", grants: [...templateGrants("existing", CTX), server("s1", "read")] },
      CTX,
    );
    expect(withServer.template).toBe("custom");
  });

  it("read-only moves BETWEEN the unscoped templates instead of going custom", () => {
    const full = sel({ template: "full" });
    const ro = reduceSelection(full, { type: "setReadOnly", on: true }, CTX);
    expect(ro.template).toBe("readOnly");
    expect(reduceSelection(ro, { type: "setReadOnly", on: false }, CTX).template).toBe("full");
  });

  it("read-only on a scoped selection relabels it custom", () => {
    expect(reduceSelection(agent, { type: "setReadOnly", on: true }, CTX).template).toBe("custom");
  });

  it("a picker change keeps the create capability", () => {
    const next = reduceSelection(agent, { type: "pickerChange", grants: [server("s1", "read")] }, CTX);
    expect(hasCreateCapability(next.grants)).toBe(true);
    expect(next.grants.some((g) => g.resourceType === "server")).toBe(true);
    // the picker's payload replaced the github rows it owns
    expect(next.grants.some((g) => g.resourceType === "github_installation")).toBe(false);
    expect(next.template).toBe("custom");
  });

  it("removing one row from the summary panel edits the same state and relabels", () => {
    const removed = reduceSelection(
      agent,
      { type: "removeGrant", resourceType: "github_installation", resourceId: "acme" },
      CTX,
    );
    expect(removed.grants.some((g) => g.resourceId === "acme")).toBe(false);
    expect(removed.grants.some((g) => g.resourceId === "hydra")).toBe(true);
    expect(removed.template).toBe("custom");
  });

  it("a level change arrives as a whole-set pickerChange from the editor", () => {
    // Levels are set in the left-hand editor, which writes through the picker's
    // controlled value — there is no separate level action to keep in sync.
    const next = reduceSelection(
      agent,
      {
        type: "pickerChange",
        grants: [ghOrg("acme", "read"), ghOrg("hydra", "read", "write")],
      },
      CTX,
    );
    expect(next.grants.find((g) => g.resourceId === "hydra")!.permissions).toEqual(["read", "write"]);
    expect(hasCreateCapability(next.grants)).toBe(true);
  });
});

describe("reduceSelection — catalogReady", () => {
  it("re-seeds a pristine preset with the accounts it couldn't know at first paint", () => {
    const pristine = sel({ template: "agent", grants: templateGrants("agent", NO_GH) });
    const seeded = reduceSelection(pristine, { type: "catalogReady" }, CTX);
    expect(sameGrantSet(seeded.grants, templateGrants("agent", CTX))).toBe(true);
  });

  it("never clobbers a scope the user already edited", () => {
    const edited = sel({ template: "custom", grants: [project("p1", "read")] });
    expect(reduceSelection(edited, { type: "catalogReady" }, CTX)).toEqual(edited);

    const full = sel({ template: "full" });
    expect(reduceSelection(full, { type: "catalogReady" }, CTX)).toEqual(full);
  });
});

describe("authorizeBlockedReason — the zero-grants-means-everything footgun", () => {
  it("blocks a scoped selection with nothing selected", () => {
    expect(authorizeBlockedReason(sel({ template: "existing" }))).toBe("noResources");
  });

  it("blocks a scoped selection whose every grant has had its permissions cleared", () => {
    expect(authorizeBlockedReason(sel({ grants: [project("p1")] }))).toBe("noPermissions");
  });

  it("allows an intentionally unscoped selection", () => {
    expect(authorizeBlockedReason(sel({ template: "full" }))).toBeNull();
    expect(authorizeBlockedReason(sel({ template: "readOnly", readOnly: true }))).toBeNull();
  });

  it("allows a scoped selection with at least one live grant", () => {
    expect(authorizeBlockedReason(sel({ grants: [project("p1", "read")] }))).toBeNull();
    expect(authorizeBlockedReason(sel({ template: "agent", grants: [PROJECT_CREATE_GRANT] }))).toBeNull();
  });
});

describe("create capability", () => {
  it("round-trips and is always written create-only", () => {
    const on = setCreateCapability([project("p1", "read")], true);
    expect(hasCreateCapability(on)).toBe(true);
    expect(on.find((g) => g.resourceId === "*")!.permissions).toEqual(["create"]);
    expect(hasCreateCapability(setCreateCapability(on, false))).toBe(false);
  });

  it("turning it on twice does not duplicate the grant", () => {
    const twice = setCreateCapability(setCreateCapability([], true), true);
    expect(twice.filter((g) => g.resourceId === "*")).toHaveLength(1);
  });

  it("is hidden from the ResourcePicker so it can't trip the wildcard branch", () => {
    const grants = [PROJECT_CREATE_GRANT, project("p1", "read")];
    expect(pickerGrants(grants)).toEqual([project("p1", "read")]);
    expect(pickerGrants(grants).some((g) => g.resourceId === "*")).toBe(false);
  });

  it("survives a picker round-trip", () => {
    const grants = [PROJECT_CREATE_GRANT, project("p1", "read")];
    const merged = mergePickerGrants(grants, [...pickerGrants(grants), server("s1", "read")]);
    expect(hasCreateCapability(merged)).toBe(true);
    expect(merged).toHaveLength(3);
  });

  it("a picker result carrying a project wildcard cannot smuggle one in", () => {
    expect(mergePickerGrants([], [project("*", "read", "write")])).toEqual([]);
  });
});

describe("readOnlyContradictions", () => {
  it("says nothing when read-only is off", () => {
    expect(
      readOnlyContradictions(sel({ grants: [PROJECT_CREATE_GRANT, project("p1", "write")] })),
    ).toEqual({ create: false, writes: 0 });
  });

  it("flags create and every write/admin grant that read-only silently cancels", () => {
    expect(
      readOnlyContradictions(
        sel({
          grants: [PROJECT_CREATE_GRANT, project("p1", "write"), project("p2", "read"), ghOrg("acme", "admin")],
          readOnly: true,
        }),
      ),
    ).toEqual({ create: true, writes: 2 });
  });

  it("says nothing for the read-only TEMPLATE — it sends no grants to contradict", () => {
    expect(
      readOnlyContradictions(sel({ template: "readOnly", grants: [PROJECT_CREATE_GRANT], readOnly: true })),
    ).toEqual({ create: false, writes: 0 });
  });
});

describe("capabilityDigest", () => {
  it("describes the default template honestly", () => {
    const d = capabilityDigest(sel({ template: "agent", grants: templateGrants("agent", CTX) }));
    expect(d.can).toEqual(["createProjects", "manageOwnProjects", "readGithub"]);
    // the whole point of the default: nothing that already exists
    expect(d.cannot).toContain("notExistingProjects");
    expect(d.cannot).toContain("notServers");
  });

  it("does not claim it can delete when no grant carries admin", () => {
    const d = capabilityDigest(sel({ grants: [project("p1", "read", "write")] }));
    expect(d.cannot).toContain("notDelete");
    const withAdmin = capabilityDigest(sel({ grants: [project("p1", "read", "write", "admin")] }));
    expect(withAdmin.cannot).not.toContain("notDelete");
  });

  it("warns that concrete project grants cannot enumerate — only the create wildcard lists", () => {
    expect(capabilityDigest(sel({ grants: [project("p1", "read")] })).cannot).toContain(
      "notEnumerateProjects",
    );
    expect(
      capabilityDigest(sel({ template: "agent", grants: templateGrants("agent", CTX) })).cannot,
    ).not.toContain("notEnumerateProjects");
  });

  it("collapses to one line for the unscoped templates", () => {
    expect(capabilityDigest(sel({ template: "full" }))).toEqual({ can: ["everything"], cannot: [] });
    expect(capabilityDigest(sel({ template: "readOnly", readOnly: true }))).toEqual({
      can: ["readEverything"],
      cannot: ["noWrites"],
    });
  });

  it("never claims a write capability while read-only is on", () => {
    const d = capabilityDigest(
      sel({ grants: [PROJECT_CREATE_GRANT, project("p1", "read", "write"), ghOrg("acme", "write")], readOnly: true }),
    );
    expect(d.can).not.toContain("manageOwnProjects");
    expect(d.can).not.toContain("operatePickedProjects");
    expect(d.can).not.toContain("writeGithub");
    expect(d.can).toContain("viewPickedProjects");
    expect(d.can).toContain("readGithub");
    expect(d.cannot).toContain("noWrites");
  });

  it("emits no key twice and never contradicts itself", () => {
    const cases: AccessSelection[] = [
      sel({ template: "agent", grants: templateGrants("agent", CTX) }),
      sel({ template: "existing", grants: [...templateGrants("existing", CTX), project("p1", "read", "write")] }),
      sel({ grants: [server("s1", "read"), project("p1", "read")] }),
      sel({ template: "full" }),
      sel({ template: "readOnly", readOnly: true }),
      sel({ grants: [PROJECT_CREATE_GRANT], readOnly: true }),
    ];
    for (const c of cases) {
      const d = capabilityDigest(c);
      expect(new Set(d.can).size).toBe(d.can.length);
      expect(new Set(d.cannot).size).toBe(d.cannot.length);
      // "can servers" and "cannot servers" must never both appear
      expect(d.can.includes("servers") && d.cannot.includes("notServers")).toBe(false);
    }
  });
});

describe("summaryRows", () => {
  it("puts the capability first, then groups by type with wildcards ahead of specifics", () => {
    const rows = summaryRows(
      [ghOrg("acme", "read"), project("p2", "read"), server("*", "read"), PROJECT_CREATE_GRANT, project("p1", "read", "write")],
      new Map([
        [labelKey("project", "p1"), "storefront"],
        [labelKey("project", "p2"), "api"],
      ]),
    );
    expect(rows.map((r) => `${r.kind}:${r.resourceType}:${r.label}`)).toEqual([
      "capability:project:*",
      "grant:project:api",
      "grant:project:storefront",
      "grant:github_installation:acme",
      "grant:server:*",
    ]);
    expect(rows.find((r) => r.resourceType === "server")!.wildcard).toBe(true);
    expect(rows[0]!.wildcard).toBe(false); // the capability is not a wildcard row
  });

  it("carries the named level for the summary's level control", () => {
    const rows = summaryRows([project("p1", "read", "write")]);
    expect(rows[0]!.level).toBe("manage");
  });

  it("omits grants whose permissions were all cleared — dropped server-side too", () => {
    expect(summaryRows([project("p1"), project("p2", "read")])).toHaveLength(1);
  });

  it("falls back to the raw id when the catalog has no label", () => {
    expect(summaryRows([project("cuid_abc", "read")])[0]!.label).toBe("cuid_abc");
  });
});

describe("summaryGroups", () => {
  it("buckets by type and reports the level they share, so one control replaces five", () => {
    // The exact shape the default template produces for a user with 5 GitHub accounts.
    const grants = [
      PROJECT_CREATE_GRANT,
      ghOrg("Hydralerne", "read"),
      ghOrg("infobrim-bi", "read"),
      ghOrg("medicascope", "read"),
      ghOrg("oblien", "read"),
      ghOrg("ONVO-me", "read"),
    ];
    const groups = summaryGroups(summaryRows(grants));
    expect(groups).toHaveLength(2);
    expect(groups[0]!.resourceType).toBeNull(); // capability bucket first
    expect(groups[0]!.rows).toHaveLength(1);
    expect(groups[0]!.sharedLevel).toBeNull();
    expect(groups[1]!.resourceType).toBe("github_installation");
    expect(groups[1]!.rows).toHaveLength(5);
    expect(groups[1]!.sharedLevel).toBe("view");
  });

  it("reports no shared level once one row differs, so each row gets its own control", () => {
    const groups = summaryGroups(
      summaryRows([ghOrg("acme", "read"), ghOrg("hydra", "read", "write")]),
    );
    expect(groups[0]!.sharedLevel).toBeNull();
    expect(groups[0]!.rows.map((r) => r.level)).toEqual(["view", "manage"]);
  });

  it("keeps types in a stable order and never mixes them", () => {
    const groups = summaryGroups(
      summaryRows([server("s1", "read"), project("p1", "read"), ghOrg("acme", "read"), server("s2", "read")]),
    );
    expect(groups.map((g) => g.resourceType)).toEqual(["project", "github_installation", "server"]);
    expect(groups[2]!.rows).toHaveLength(2);
  });

  it("emits no group at all for an empty selection", () => {
    expect(summaryGroups([])).toEqual([]);
  });
});

describe("group removal from the summary", () => {
  const agentPlus = sel({
    template: "agent",
    grants: [PROJECT_CREATE_GRANT, ghOrg("acme", "read"), ghOrg("hydra", "read")],
  });



  it("removeType drops the whole group but keeps the create capability", () => {
    const withProject = sel({ grants: [PROJECT_CREATE_GRANT, project("p1", "read"), project("p2", "read")] });
    const next = reduceSelection(withProject, { type: "removeType", resourceType: "project" }, CTX);
    expect(next.grants).toEqual([PROJECT_CREATE_GRANT]);
    expect(hasCreateCapability(next.grants)).toBe(true);
  });

  it("removeType relabels, and clearing everything still blocks Authorize", () => {
    const onlyGithub = sel({ template: "existing", grants: [ghOrg("acme", "read")] });
    const next = reduceSelection(onlyGithub, { type: "removeType", resourceType: "github_installation" }, CTX);
    expect(next.grants).toEqual([]);
    expect(authorizeBlockedReason(next)).toBe("noResources");
  });
});

describe("dropRejectedGrant", () => {
  const grants = [PROJECT_CREATE_GRANT, ghOrg("acme", "read"), project("p1", "read")];

  it("parses GRANT_EXCEEDS_ACCESS and drops exactly that grant", () => {
    const res = dropRejectedGrant(
      grants,
      "You can't grant access you don't have yourself: github_installation / acme",
    );
    expect(res).not.toBeNull();
    expect(res!.dropped).toEqual(ghOrg("acme", "read"));
    expect(res!.grants).toEqual([PROJECT_CREATE_GRANT, project("p1", "read")]);
  });

  it("handles a repo id that itself contains a slash", () => {
    const withRepo: PickerGrant[] = [
      ...grants,
      { resourceType: "github_repository", resourceId: "acme/web", permissions: ["read"] },
    ];
    const res = dropRejectedGrant(
      withRepo,
      "You can't grant access you don't have yourself: github_repository / acme/web",
    );
    expect(res!.dropped.resourceId).toBe("acme/web");
  });

  it("returns null when the message names nothing we hold, so the caller shows the raw error", () => {
    expect(dropRejectedGrant(grants, "You can't grant access you don't have yourself: server / s9")).toBeNull();
    expect(dropRejectedGrant(grants, "Something else went wrong")).toBeNull();
  });
});

describe("small helpers", () => {
  it("sameGrantSet ignores order and permission order but not content", () => {
    expect(sameGrantSet([project("p1", "read", "write")], [project("p1", "write", "read")])).toBe(true);
    expect(sameGrantSet([project("p1", "read")], [project("p1", "read", "write")])).toBe(false);
    expect(sameGrantSet([], [])).toBe(true);
  });

  it("removeGrant only removes the exact type+id pair", () => {
    expect(removeGrant([project("p1", "read"), ghOrg("p1", "read")], "project", "p1")).toEqual([
      ghOrg("p1", "read"),
    ]);
  });
});

/**
 * Source access rides on PickerGrant, so it has to survive the consent screen's
 * grant pipeline: ResourcePicker hands its value back through mergePickerGrants,
 * and wireGrants decides what actually goes on the wire. A filter that rebuilt
 * grants instead of passing them through would silently drop the scope — the
 * operator would pick "read only src/**", authorise, and mint a metadata-only
 * token (or, if the default ever flipped, a wide-open one).
 */
describe("source access survives the consent pipeline", () => {
  const scoped = {
    resourceType: "github_repository" as const,
    resourceId: "hydralerne/charts",
    permissions: ["read" as const],
    scope: { v: 1 as const, read: { paths: ["src/**"] } },
  };

  it("pickerGrants keeps the scope (it only holds back the project wildcard)", () => {
    expect(pickerGrants([PROJECT_CREATE_GRANT, scoped])).toEqual([scoped]);
  });

  it("mergePickerGrants passes the scope through untouched", () => {
    const merged = mergePickerGrants([PROJECT_CREATE_GRANT], [scoped]);
    expect(merged).toContainEqual(scoped);
    expect(merged.find((g) => g.resourceId === "hydralerne/charts")?.scope?.read?.paths).toEqual([
      "src/**",
    ]);
  });

  it("wireGrants sends the scope", () => {
    const wired = wireGrants({ template: "custom", grants: [scoped], readOnly: false });
    expect(wired).toEqual([scoped]);
  });

  it("a zero-permission grant is still dropped, scope or not", () => {
    const empty = { ...scoped, permissions: [] };
    expect(wireGrants({ template: "custom", grants: [empty], readOnly: false })).toEqual([]);
  });
});

/**
 * "Can it read my source?" is the question a repo grant raises and the digest used
 * to leave unanswered — it said "reads your GitHub repositories", which is true of a
 * deploy-only grant that can read no file at all. Stated explicitly either way now.
 */
describe("the digest answers the file-contents question", () => {
  const repo = (scope?: { v: 1; read?: { paths: string[] } }) => ({
    template: "custom" as const,
    readOnly: false,
    grants: [
      {
        resourceType: "github_repository" as const,
        resourceId: "hydralerne/charts",
        permissions: ["read" as const],
        ...(scope ? { scope } : {}),
      },
    ],
  });

  it("says it CANNOT read contents when the grant is deploy-only", () => {
    const d = capabilityDigest(repo());
    expect(d.cannot).toContain("notReadSource");
    expect(d.can).not.toContain("readSource");
  });

  it("says it CAN read contents once paths are scoped", () => {
    const d = capabilityDigest(repo({ v: 1, read: { paths: ["src/**"] } }));
    expect(d.can).toContain("readSource");
    expect(d.cannot).not.toContain("notReadSource");
  });

  it("an empty path list is not content access", () => {
    // A scope carrying no readable path grants nothing, so it must not claim to.
    const d = capabilityDigest(repo({ v: 1, read: { paths: [] } }));
    expect(d.cannot).toContain("notReadSource");
  });

  it("says nothing either way when there is no github grant at all", () => {
    const d = capabilityDigest({ template: "custom", readOnly: false, grants: [] });
    expect(d.can).not.toContain("readSource");
    expect(d.cannot).not.toContain("notReadSource");
  });
});
