/**
 * Access templates for the MCP consent screen — the pure part.
 *
 * A template is a NAMED GRANT SET the user starts from and then edits, not a
 * one-way mode switch. Everything here is a pure function so the whole state
 * machine is unit-testable without a DOM (the dashboard has no jsdom setup — see
 * confirm-server-access.ts for the same component/logic split).
 *
 * ── The one rule that shapes this file ───────────────────────────────────────
 * An UNSCOPED binding lets the client act with the consenting user's own role, so
 * "I trimmed my scope to nothing" and "I deliberately want no limits" must never
 * be confusable. They used to be the SAME wire payload — zero grants meant full
 * access — leaving the UI as the only thing that could tell them apart. The server
 * now requires `fullAccess: true` to mint an unscoped binding and rejects an empty
 * grant list without it (token.controller.ts resolveScopeIntent), so the two
 * intents are distinct on the wire and the dangerous one fails closed.
 *
 * The UI still carries the intent rather than deriving it: the chosen template is
 * stored, never inferred from `grants.length`; `wireGrants` returns [] only for a
 * template whose card says so in words; `isUnscopedTemplate` is what the consent
 * page sends as `fullAccess`; and `authorizeBlockedReason` stops the other case
 * dead before submit. Belt and braces, now with a server-side brace.
 *
 * ── What the server will and won't accept (apps/api) ─────────────────────────
 *   - {project,"*"} must be EXACTLY ["create"] — token.schema.ts
 *     wildcardProjectGrantRejected, enforced at token.controller.ts:92-101.
 *     Read/write/admin on projects must name concrete ids.
 *   - "create" is collection-only: it authorizes POST /api/projects and the
 *     project list, nothing per-id. permission.ts:338-357.
 *   - Creating a project auto-grants {project,<newId>,[read,write,admin]} to the
 *     token, so "create" accrues full control of its OWN projects over time.
 *     project.controller.ts:395-399.
 *   - Permissions are cumulative at check time — read ⇐ read|write|admin,
 *     write ⇐ write|admin (permission.ts:383-398) — which is what makes the
 *     three named levels below a lossless view of the underlying arrays.
 *   - GitHub is default-deny; the grant's resourceId is the account LOGIN, not an
 *     installation id (github-access.ts:113), and ["read"] is enough to deploy.
 *   - billing and audit grants authorize NOTHING for a scoped principal in any
 *     form: every billing/audit route is an org-singleton asserting resourceId
 *     "*", which the restricted arm always denies. They're offered by the generic
 *     picker but deliberately not here.
 *   - Every grant is re-validated ⊆ the consenting user's own access; the first
 *     one that isn't returns 403 GRANT_EXCEEDS_ACCESS naming it, which is what
 *     `dropRejectedGrant` parses.
 */

import type { Permission, PickerGrant, ResourceType } from "@/lib/api";

/**
 * `agent` is the default. It is deliberately NOT full access: create projects,
 * fully manage the ones it creates, read the repos it needs to deploy from — and
 * nothing that already exists is visible to it.
 */
export type AccessTemplateId = "agent" | "existing" | "readOnly" | "full" | "custom";

/** Order the cards are offered in. `custom` is derived, never picked. */
export const TEMPLATE_ORDER: readonly AccessTemplateId[] = ["agent", "existing", "readOnly", "full"];

/** Templates that intentionally send NO grants (client acts with the user's role). */
const UNSCOPED_TEMPLATES: ReadonlySet<AccessTemplateId> = new Set(["full", "readOnly"]);

export function isUnscopedTemplate(id: AccessTemplateId): boolean {
  return UNSCOPED_TEMPLATES.has(id);
}

/** Resource types this screen offers. `billing`/`audit` are excluded because a
 *  scoped grant on them is dead weight (see the header note). */
export function grantableTypes(selfHosted: boolean): ResourceType[] {
  return selfHosted
    ? ["project", "github_installation", "github_repository", "server", "mail_server", "backup_destination"]
    : ["project", "github_installation", "github_repository", "backup_destination"];
}

/** Types kept out of the primary tab strip — they unlock no MCP tool, but the
 *  same bearer can still reach per-id REST routes, so they stay available. */
export const ADVANCED_TYPES: ReadonlySet<ResourceType> = new Set([
  "server",
  "mail_server",
  "backup_destination",
]);

// ── Named access levels ─────────────────────────────────────────────────────

/**
 * read/write/admin rendered as three cumulative levels. Lossless because the
 * server's check is cumulative (permission.ts:383-398): ["write"] and
 * ["read","write"] authorize identically, so normalizing to the cumulative set
 * on write changes nothing about what the token can do.
 */
export type AccessLevel = "view" | "manage" | "full";

export const ACCESS_LEVELS: readonly AccessLevel[] = ["view", "manage", "full"];

export const LEVEL_PERMISSIONS: Record<AccessLevel, Permission[]> = {
  view: ["read"],
  manage: ["read", "write"],
  full: ["read", "write", "admin"],
};

export function levelOf(permissions: readonly Permission[]): AccessLevel {
  if (permissions.includes("admin")) return "full";
  if (permissions.includes("write")) return "manage";
  return "view";
}

/** The "projects it creates" capability, as a grant. The generic ResourcePicker
 *  only deals in read/write/admin and can't express it, so the wizard surfaces it
 *  as its own toggle and keeps it OUT of the picker's value. */
export const PROJECT_CREATE_GRANT: PickerGrant = {
  resourceType: "project",
  resourceId: "*",
  permissions: ["create"],
};

export function isProjectCreateGrant(g: PickerGrant): boolean {
  return g.resourceType === "project" && g.resourceId === "*";
}

export interface TemplateContext {
  /**
   * GitHub account logins to seed, from GET /api/github/home → `accounts`.
   *
   * That endpoint runs `filterAllowedAccounts`, so it returns exactly what THIS
   * user may re-grant. Do NOT use GET /api/permissions/resources?type=
   * github_installation here: that catalog is fetched as the org owner and is
   * unfiltered, so for a non-owner admin it lists accounts they don't hold and
   * the mint 403s GRANT_EXCEEDS_ACCESS on a grant the user never knowingly added.
   */
  githubAccounts: readonly string[];
}

export interface AccessSelection {
  /** Stored, never inferred. Unscoped-ness is INTENT — deriving it from
   *  `grants.length === 0` is exactly the footgun described at the top. */
  template: AccessTemplateId;
  /** Retained across template switches so a user's edits survive exploring the
   *  presets. Not what goes on the wire — see `wireGrants`. */
  grants: PickerGrant[];
  readOnly: boolean;
}

/**
 * The grants to actually send. An unscoped template sends none regardless of
 * what's retained in state, and zero-permission rows are dropped (the server
 * drops them too, so keeping them would overstate the scope).
 */
export function wireGrants(selection: AccessSelection): PickerGrant[] {
  if (isUnscopedTemplate(selection.template)) return [];
  return selection.grants.filter((g) => g.permissions.length > 0);
}

/**
 * Guard for the submit path. `wireGrants` returning [] for a scoped template
 * would silently mint an UNSCOPED binding, so the caller asserts this can't
 * happen rather than trusting the UI's disabled state.
 */
export function wouldSilentlyGrantEverything(selection: AccessSelection): boolean {
  return !isUnscopedTemplate(selection.template) && wireGrants(selection).length === 0;
}

/** Read-only account grants for every seeded GitHub account. */
function githubSeed(ctx: TemplateContext): PickerGrant[] {
  return ctx.githubAccounts.map((login) => ({
    resourceType: "github_installation",
    resourceId: login,
    permissions: ["read"],
  }));
}

/** The grant set a template stands for, resolved against the live catalog. */
export function templateGrants(id: AccessTemplateId, ctx: TemplateContext): PickerGrant[] {
  switch (id) {
    case "agent":
      // Read is all a deploy needs, and it's the least we can ask for. One grant
      // per account login covers every repo under it.
      return [PROJECT_CREATE_GRANT, ...githubSeed(ctx)];
    case "existing":
      // DELIBERATELY no projects. Pre-selecting the org's projects would turn a
      // two-click Authorize into a write grant over everything that exists —
      // the opposite of what picking a narrow template means. GitHub read is
      // seeded because redeploying a git-linked project asserts repo read.
      return githubSeed(ctx);
    default:
      return [];
  }
}

export function templateReadOnly(id: AccessTemplateId): boolean {
  return id === "readOnly";
}

/**
 * Fresh selection for a template the user just clicked.
 *
 * `custom` and the unscoped templates KEEP the retained grants: switching to Full
 * access and back must not throw away a scope the user spent time building. Only
 * picking a concrete preset overwrites them, which is what picking one means.
 */
export function applyTemplate(
  id: AccessTemplateId,
  current: AccessSelection,
  ctx: TemplateContext,
): AccessSelection {
  if (id === "custom") return { ...current, template: "custom" };
  if (isUnscopedTemplate(id)) return { ...current, template: id, readOnly: templateReadOnly(id) };
  return { template: id, grants: templateGrants(id, ctx), readOnly: templateReadOnly(id) };
}

// ── Grant-set comparison (order-insensitive) ────────────────────────────────

function grantKey(g: PickerGrant): string {
  return `${g.resourceType} ${g.resourceId} ${[...g.permissions].sort().join(",")}`;
}

export function sameGrantSet(a: readonly PickerGrant[], b: readonly PickerGrant[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map(grantKey).sort();
  const right = b.map(grantKey).sort();
  return left.every((k, i) => k === right[i]);
}

/**
 * Does the selection still mean "Existing projects"? That template exists to be
 * filled in, so it has to keep its name while the user picks — matching it on
 * exact equality would flip the card to Custom on the first click.
 *
 * Its shape: no create capability, not read-only, and every grant is either a
 * CONCRETE project or one of the seeded GitHub accounts.
 */
function matchesExisting(selection: AccessSelection, ctx: TemplateContext): boolean {
  if (selection.readOnly) return false;
  if (hasCreateCapability(selection.grants)) return false;
  const seeded = new Set(githubSeed(ctx).map(grantKey));
  return selection.grants.every((g) => {
    if (g.resourceType === "project") return g.resourceId !== "*";
    return seeded.has(grantKey(g));
  });
}

/**
 * Re-label a SCOPED selection after an edit. A template is a starting point, so
 * the name must stop claiming the preset once the grants diverge — otherwise the
 * screen reads "Coding agent" while granting something else. Reverting an edit
 * exactly restores the name.
 *
 * Only ever reached for scoped selections: unscoped-ness is stored intent and an
 * edit can't touch it (the editor isn't rendered).
 */
function relabel(selection: AccessSelection, ctx: TemplateContext): AccessSelection {
  if (isUnscopedTemplate(selection.template)) return selection;
  if (!selection.readOnly && sameGrantSet(selection.grants, templateGrants("agent", ctx))) {
    return { ...selection, template: "agent" };
  }
  if (matchesExisting(selection, ctx)) return { ...selection, template: "existing" };
  return { ...selection, template: "custom" };
}

// ── Editing helpers ─────────────────────────────────────────────────────────

export function hasCreateCapability(grants: readonly PickerGrant[]): boolean {
  return grants.some(isProjectCreateGrant);
}

/** Toggle the "create new projects" capability. Always written create-only — any
 *  other permission set on {project,"*"} is a 400 at mint. */
export function setCreateCapability(grants: readonly PickerGrant[], on: boolean): PickerGrant[] {
  const without = grants.filter((g) => !isProjectCreateGrant(g));
  return on ? [...without, PROJECT_CREATE_GRANT] : without;
}

/**
 * The subset the generic ResourcePicker owns. The create capability is held back
 * so the picker never sees a {project,"*"} grant — which would otherwise trip its
 * `wildcardActive` branch and render EVERY specific project row disabled and
 * "covered by All projects" (ResourcePicker.tsx), i.e. a broken editor under the
 * default template.
 */
export function pickerGrants(grants: readonly PickerGrant[]): PickerGrant[] {
  return grants.filter((g) => !isProjectCreateGrant(g));
}

/** Merge a ResourcePicker result back, preserving the create capability and
 *  refusing any project wildcard the picker might emit. */
export function mergePickerGrants(
  previous: readonly PickerGrant[],
  next: readonly PickerGrant[],
): PickerGrant[] {
  const create = previous.filter(isProjectCreateGrant);
  return [...create, ...next.filter((g) => !isProjectCreateGrant(g))];
}

export function removeGrant(
  grants: readonly PickerGrant[],
  resourceType: ResourceType,
  resourceId: string,
): PickerGrant[] {
  return grants.filter((g) => !(g.resourceType === resourceType && g.resourceId === resourceId));
}

// ── Reducer ─────────────────────────────────────────────────────────────────

/**
 * Every way the wizard can change the scope. Keeping these here rather than in
 * the component means the whole state machine — relabelling, the create/picker
 * interplay, the read-only special case — is covered by plain unit tests.
 */
export type ScopeAction =
  | { type: "pickTemplate"; id: AccessTemplateId }
  /** Whole-set replacement from the ResourcePicker (which can't see the create
   *  capability, so it's re-merged). */
  | { type: "pickerChange"; grants: PickerGrant[] }
  | { type: "setCreate"; on: boolean }
  | { type: "setReadOnly"; on: boolean }
  | { type: "removeGrant"; resourceType: ResourceType; resourceId: string }
  /** Drop a whole group at once, from the summary's group header. */
  | { type: "removeType"; resourceType: ResourceType }
  /** The catalog finished loading after first paint — re-seed an untouched
   *  preset so it picks up accounts it couldn't know about yet. */
  | { type: "catalogReady" };

export function reduceSelection(
  state: AccessSelection,
  action: ScopeAction,
  ctx: TemplateContext,
): AccessSelection {
  switch (action.type) {
    case "pickTemplate":
      return applyTemplate(action.id, state, ctx);

    case "catalogReady":
      // Only re-seed a pristine preset. Once it says "custom" the user has
      // touched it and re-seeding would silently discard their edits.
      return state.template === "agent" || state.template === "existing"
        ? { ...state, grants: templateGrants(state.template, ctx) }
        : state;

    case "pickerChange":
      return relabel({ ...state, grants: mergePickerGrants(state.grants, action.grants) }, ctx);

    case "setCreate":
      return relabel({ ...state, grants: setCreateCapability(state.grants, action.on) }, ctx);

    case "setReadOnly": {
      // While unscoped, read-only IS the difference between the two unscoped
      // templates, so the toggle moves between them instead of going custom.
      if (isUnscopedTemplate(state.template)) {
        return { ...state, readOnly: action.on, template: action.on ? "readOnly" : "full" };
      }
      return relabel({ ...state, readOnly: action.on }, ctx);
    }

    case "removeGrant":
      return relabel(
        { ...state, grants: removeGrant(state.grants, action.resourceType, action.resourceId) },
        ctx,
      );


    case "removeType":
      return relabel(
        {
          ...state,
          // Keeps the create capability: it lives under `project` but is a
          // capability, not one of the listed project resources.
          grants: state.grants.filter(
            (g) => g.resourceType !== action.resourceType || isProjectCreateGrant(g),
          ),
        },
        ctx,
      );

    default: {
      const _exhaustive: never = action;
      return state;
    }
  }
}

// ── Gating ──────────────────────────────────────────────────────────────────

/** Why Authorize is disabled, as a stable key the component maps to copy. */
export type BlockedReason = "noResources" | "noPermissions";

/**
 * A scoped selection with nothing in it would be sent as zero grants and read as
 * FULL access — the exact opposite of what the user chose. Block it.
 */
export function authorizeBlockedReason(selection: AccessSelection): BlockedReason | null {
  if (isUnscopedTemplate(selection.template)) return null;
  if (wireGrants(selection).length > 0) return null;
  // Distinguish "nothing picked" from "picked, then cleared every permission" —
  // the fix differs and the second is easy to do by accident.
  return selection.grants.length > 0 ? "noPermissions" : "noResources";
}

/**
 * Read-only is enforced as a blunt HTTP-method gate — `enforceBoundOrgAndReadOnly`
 * rejects every POST/PUT/PATCH/DELETE with 403 TOKEN_READ_ONLY before any
 * permission check runs (auth.ts) — so it silently cancels everything
 * write-shaped in the same selection. "Create new projects" becomes literally
 * unreachable. Surface it as a conflict with a way out, never a silent no-op.
 */
export function readOnlyContradictions(selection: AccessSelection): {
  create: boolean;
  writes: number;
} {
  if (!selection.readOnly) return { create: false, writes: 0 };
  const live = wireGrants(selection);
  return {
    create: hasCreateCapability(live),
    writes: live.filter(
      (g) => !isProjectCreateGrant(g) && g.permissions.some((p) => p === "write" || p === "admin"),
    ).length,
  };
}

// ── Plain-language digest ───────────────────────────────────────────────────

/**
 * Stable keys the component maps to copy. Derived from the selection so the
 * "can / cannot" list can't drift from the grants it describes.
 *
 * These encode conclusions about ~149 route specs. They are asserted for
 * self-consistency in the unit tests, but a route retagged in the API can still
 * make a line stale — treat the digest as a summary of the GRANTS, which is what
 * it literally is, not as a guarantee about every tool.
 */
export type DigestKey =
  // can …
  | "createProjects"
  | "manageOwnProjects"
  | "operatePickedProjects"
  | "viewPickedProjects"
  | "readGithub"
  | "writeGithub"
  | "readSource"
  | "servers"
  | "backups"
  | "everything"
  | "readEverything"
  // cannot …
  | "notExistingProjects"
  | "notEnumerateProjects"
  | "notServers"
  | "notDelete"
  | "notReadSource"
  | "noWrites";

export interface CapabilityDigest {
  can: DigestKey[];
  cannot: DigestKey[];
}

export function capabilityDigest(selection: AccessSelection): CapabilityDigest {
  const can: DigestKey[] = [];
  const cannot: DigestKey[] = [];

  if (isUnscopedTemplate(selection.template)) {
    can.push(selection.readOnly ? "readEverything" : "everything");
    if (selection.readOnly) cannot.push("noWrites");
    return { can, cannot };
  }

  const live = wireGrants(selection);
  const create = hasCreateCapability(live);
  const projects = live.filter((g) => g.resourceType === "project" && g.resourceId !== "*");
  const github = live.filter(
    (g) => g.resourceType === "github_installation" || g.resourceType === "github_repository",
  );
  const servers = live.filter((g) => g.resourceType === "server" || g.resourceType === "mail_server");
  const backups = live.filter((g) => g.resourceType === "backup_destination");
  const writable = (gs: PickerGrant[]) => gs.some((g) => g.permissions.some((p) => p === "write" || p === "admin"));

  if (create) {
    can.push("createProjects");
    // The auto-grant on create is what makes this true — without it a created
    // project would be invisible to the client that created it.
    if (!selection.readOnly) can.push("manageOwnProjects");
  }
  if (projects.length > 0) {
    can.push(writable(projects) && !selection.readOnly ? "operatePickedProjects" : "viewPickedProjects");
  }
  if (github.length > 0) {
    can.push(writable(github) && !selection.readOnly ? "writeGithub" : "readGithub");
    // A repo grant is DEPLOY-ONLY unless its scope names read paths, so "reads your
    // GitHub repositories" alone is ambiguous about the thing people most want to
    // know: can it see my source? State it either way rather than leaving it out.
    if (github.some((g) => (g.scope?.read?.paths?.length ?? 0) > 0)) {
      can.push("readSource");
    } else {
      cannot.push("notReadSource");
    }
  }
  if (servers.length > 0) can.push("servers");
  if (backups.length > 0) can.push("backups");

  if (selection.readOnly) cannot.push("noWrites");
  if (projects.length === 0) cannot.push("notExistingProjects");
  // Only the create wildcard authorizes the project LIST route; concrete grants
  // reach projects by id but 404 on enumeration (permission.ts:353-355).
  if (!create && projects.length > 0) cannot.push("notEnumerateProjects");
  if (servers.length === 0) cannot.push("notServers");
  if (!selection.readOnly && !live.some((g) => g.permissions.includes("admin")) && !create) {
    cannot.push("notDelete");
  }

  return { can, cannot };
}

// ── Summary rows for the review panel ───────────────────────────────────────

export interface SummaryRow {
  kind: "capability" | "grant";
  resourceType: ResourceType;
  resourceId: string;
  /** Display label; the catalog label when known, else the raw id — which is
   *  still the truth, just less friendly. */
  label: string;
  permissions: Permission[];
  level: AccessLevel;
  /** True for the "all X of this type" wildcard row. */
  wildcard: boolean;
}

/** Stable display order. */
const TYPE_ORDER: readonly ResourceType[] = [
  "project",
  "github_installation",
  "github_repository",
  "server",
  "mail_server",
  "backup_destination",
  "billing",
  "audit",
];

/**
 * Group the raw grants into the rows the review panel renders. `labels` maps
 * `labelKey(type, id)` → catalog label so the panel shows "storefront", not a cuid.
 */
export function summaryRows(
  grants: readonly PickerGrant[],
  labels: ReadonlyMap<string, string> = new Map(),
): SummaryRow[] {
  const rows = grants
    .filter((g) => g.permissions.length > 0)
    .map((g): SummaryRow => {
      const capability = isProjectCreateGrant(g);
      return {
        kind: capability ? "capability" : "grant",
        resourceType: g.resourceType,
        resourceId: g.resourceId,
        label: labels.get(labelKey(g.resourceType, g.resourceId)) ?? g.resourceId,
        permissions: [...g.permissions],
        level: levelOf(g.permissions),
        wildcard: !capability && g.resourceId === "*",
      };
    });

  return rows.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "capability" ? -1 : 1;
    const ta = TYPE_ORDER.indexOf(a.resourceType);
    const tb = TYPE_ORDER.indexOf(b.resourceType);
    if (ta !== tb) return ta - tb;
    if (a.wildcard !== b.wildcard) return a.wildcard ? -1 : 1;
    return a.label.localeCompare(b.label);
  });
}

export function labelKey(resourceType: string, resourceId: string): string {
  return `${resourceType} ${resourceId}`;
}

/**
 * Rows bucketed by resource type, so the review panel can render one level
 * control per GROUP instead of one per row.
 *
 * The default template seeds a grant per GitHub account, so a user with five
 * accounts otherwise gets five identical three-button controls stacked down the
 * rail — tall enough to push Authorize off screen, and it reads as five decisions
 * when it is really one.
 */
export interface SummaryGroup {
  /** `null` for the capability bucket, which has no type-level control. */
  resourceType: ResourceType | null;
  rows: SummaryRow[];
  /** The level every row shares, or `null` when they differ — in which case the
   *  group control is meaningless and each row shows its own. */
  sharedLevel: AccessLevel | null;
}

export function summaryGroups(rows: readonly SummaryRow[]): SummaryGroup[] {
  const capabilities = rows.filter((r) => r.kind === "capability");
  const groups: SummaryGroup[] = [];
  if (capabilities.length > 0) {
    groups.push({ resourceType: null, rows: capabilities, sharedLevel: null });
  }

  // `rows` arrives already sorted by type, so first-seen order is stable.
  const byType = new Map<ResourceType, SummaryRow[]>();
  for (const r of rows) {
    if (r.kind === "capability") continue;
    const bucket = byType.get(r.resourceType);
    if (bucket) bucket.push(r);
    else byType.set(r.resourceType, [r]);
  }

  for (const [resourceType, bucket] of byType) {
    const first = bucket[0]!.level;
    const sharedLevel = bucket.every((r) => r.level === first) ? first : null;
    groups.push({ resourceType, rows: bucket, sharedLevel });
  }
  return groups;
}

// ── Server-rejection recovery ───────────────────────────────────────────────

/**
 * The server refuses a grant the consenting user doesn't hold themselves with
 * 403 GRANT_EXCEEDS_ACCESS and a message ending in "<resourceType> / <id>". Parse
 * that back to a grant so the wizard can drop exactly the offending row and let
 * the user re-authorize, instead of dead-ending on a generic error.
 *
 * Reachable through no fault of the user: the GitHub tree's catalog is fetched as
 * the org owner and is unfiltered, so a non-owner admin can see and pick repos
 * `canUseGitHubRepo` will refuse for them.
 */
export function dropRejectedGrant(
  grants: readonly PickerGrant[],
  serverMessage: string,
): { grants: PickerGrant[]; dropped: PickerGrant } | null {
  const match = /([a-z_]+)\s*\/\s*(\S+)\s*$/.exec(serverMessage.trim());
  if (!match) return null;
  const [, resourceType, resourceId] = match;
  const dropped = grants.find(
    (g) => g.resourceType === resourceType && g.resourceId === resourceId,
  );
  if (!dropped) return null;
  return { grants: removeGrant(grants, dropped.resourceType, dropped.resourceId), dropped };
}
