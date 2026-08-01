"use client";

/**
 * ResourcePicker — multi-select for grantable resources, shared by the invite
 * flow, the member-grants editor, and (Phase 2) token scoping.
 *
 *   - Switch between resource types (Projects / Servers / … / GitHub)
 *   - Inline search (client-side filter)
 *   - "All resources" wildcard row that emits the `*` id
 *   - Per-row read/write/admin permission chips
 *   - GitHub is a hierarchical org→repo tree: check a whole org, OR expand it
 *     to pick specific repos. A whole-org grant supersedes its repo grants.
 *
 * Server is the source of truth — catalog rows come from
 * /api/permissions/resources?type=X (+ optional ?owner= for repos under one org).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, ChevronRight, Loader2, Search, SlidersHorizontal } from "lucide-react";
import {
  permissionsApi,
  RESOURCE_TYPE_LABELS,
  type CatalogEntry,
  type Permission,
  type PickerGrant,
  type ResourceType,
} from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api";
import { useToast } from "@/context/ToastContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { LevelSwitch, type LevelOption } from "./LevelSwitch";
import { ResourceAvatar } from "./ResourceAvatar";
import { Modal } from "@/components/ui/Modal";
import { SourceAccessModal } from "./SourceAccessModal";
import type { SourceAccessScope } from "@repo/core";

// Re-export for existing importers (TeamTab et al.) — canonical defs live in @/lib/api.
export type { Permission, PickerGrant, ResourceType } from "@/lib/api";

const PERMISSIONS: Permission[] = ["read", "write", "admin"];

const DEFAULT_TYPES: ResourceType[] = [
  "project",
  "server",
  "mail_server",
  "backup_destination",
  "billing",
  "audit",
  "github_installation",
  "github_repository",
];

/** A tab collapses the two GitHub resource types into one "github" tab. */
type TabId = ResourceType | "github";

function toTabs(types: ResourceType[]): TabId[] {
  const out: TabId[] = [];
  let github = false;
  for (const t of types) {
    if (t === "github_installation" || t === "github_repository") {
      if (!github) {
        out.push("github");
        github = true;
      }
    } else {
      out.push(t);
    }
  }
  return out;
}

function tabLabel(tab: TabId): string {
  return tab === "github" ? "GitHub" : RESOURCE_TYPE_LABELS[tab];
}

// ── Pure grant helpers (shared by the flat list + the GitHub tree) ──────────
function findGrantIn(
  value: PickerGrant[],
  resourceType: ResourceType,
  resourceId: string,
): PickerGrant | undefined {
  return value.find((g) => g.resourceType === resourceType && g.resourceId === resourceId);
}

function writeGrant(
  value: PickerGrant[],
  resourceType: ResourceType,
  resourceId: string,
  perms: Permission[],
  /** Explicit source scope. Omit to CARRY FORWARD whatever the grant already had. */
  scope?: SourceAccessScope | null,
): PickerGrant[] {
  const prev = findGrantIn(value, resourceType, resourceId);
  const next = value.filter(
    (g) => !(g.resourceType === resourceType && g.resourceId === resourceId),
  );
  if (perms.length > 0) {
    // Preserving the scope matters: this function rebuilds the grant from scratch,
    // so without it, toggling a permission chip would silently wipe a carefully
    // chosen path restriction (or re-open a repo the owner had narrowed).
    const carried = scope === undefined ? prev?.scope : (scope ?? undefined);
    next.push({ resourceType, resourceId, permissions: perms, ...(carried ? { scope: carried } : {}) });
  }
  return next;
}

export interface LevelsConfig {
  options: readonly LevelOption[];
  /** A row's permissions → the id of the option to show as active. */
  resolve: (permissions: Permission[]) => string;
  /** A chosen option id → the exact permission set to write. */
  toPermissions: (id: string) => Permission[];
}

interface ResourcePickerProps {
  /** Current selection (controlled). Caller owns the array. */
  value: PickerGrant[];
  onChange: (value: PickerGrant[]) => void;
  /** Which resource types to offer, in order. Defaults to all. Callers compute
   *  this from platform mode (e.g. hide mail_server in SaaS). */
  availableTypes?: ResourceType[];
  /** Optional: restrict to a single resource type (no type tabs shown). */
  fixedType?: ResourceType;
  /** Default permissions when a resource is first checked. Defaults to ["read"]. */
  defaultPermissions?: Permission[];
  /**
   * Types whose "All X" wildcard row must NOT be offered.
   *
   * Needed because a wildcard is not universally mintable: `{project,"*"}` on a
   * TOKEN must be exactly `["create"]` (apps/api token.schema.ts
   * `wildcardProjectGrantRejected`), so offering "All projects · read/write" in a
   * token-scoping flow builds a selection the server rejects with 400
   * INVALID_GRANT_SCOPE. The same row is legitimate for MEMBER grants, hence a
   * per-call-site prop rather than a rule baked in here.
   */
  suppressWildcardTypes?: ResourceType[];
  /**
   * Render named access levels instead of the read/write/admin chips.
   *
   * Opt-in and fully caller-defined so this component owns no level vocabulary:
   * the MCP consent screen shows View / Deploy & manage / Full control, while the
   * member-grants and PAT editors keep the raw chips. `resolve` maps a row's
   * permissions to the active option, `toPermissions` maps a chosen option back to
   * the exact set to write.
   */
  levels?: LevelsConfig;
  /**
   * Called whenever a catalog page loads, with the entries it fetched. Lets a
   * caller that renders its own view of the selection (e.g. the MCP consent
   * screen's summary panel) show "storefront" instead of a raw cuid, without
   * re-fetching the same catalogs. Must be referentially stable.
   */
  onCatalogLoaded?: (type: ResourceType, entries: CatalogEntry[]) => void;
  disabled?: boolean;
}

export function ResourcePicker({
  value,
  onChange,
  availableTypes,
  fixedType,
  defaultPermissions = ["read"],
  suppressWildcardTypes,
  levels,
  onCatalogLoaded,
  disabled,
}: ResourcePickerProps) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const w = t.widgets.permissions.resourcePicker;

  const tabs = useMemo<TabId[]>(() => {
    if (fixedType) return toTabs([fixedType]);
    return toTabs(availableTypes ?? DEFAULT_TYPES);
  }, [fixedType, availableTypes]);

  const [activeTab, setActiveTab] = useState<TabId>(tabs[0] ?? "project");
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  // Keep activeTab valid if the tab set changes (e.g. mode toggles).
  useEffect(() => {
    if (!tabs.includes(activeTab)) setActiveTab(tabs[0] ?? "project");
  }, [tabs, activeTab]);

  const isGithub = activeTab === "github";
  const isSingleton = activeTab === "billing" || activeTab === "audit";
  const wildcardSuppressed =
    !isGithub && !!suppressWildcardTypes?.includes(activeTab as ResourceType);
  const showWildcardRow = !isSingleton && !wildcardSuppressed;

  const loadCatalog = useCallback(
    async (type: ResourceType) => {
      setLoading(true);
      try {
        const res = await permissionsApi.listResources(type);
        setCatalog(res.data ?? []);
        onCatalogLoaded?.(type, res.data ?? []);
      } catch (err) {
        showToast(getApiErrorMessage(err, w.failedLoadResources), "error", "Picker");
        setCatalog([]);
      } finally {
        setLoading(false);
      }
    },
    [showToast, onCatalogLoaded],
  );

  useEffect(() => {
    setSearch("");
    if (!isGithub) void loadCatalog(activeTab as ResourceType);
  }, [activeTab, isGithub, loadCatalog]);

  const toggleResource = (resourceType: ResourceType, resourceId: string) => {
    const existing = findGrantIn(value, resourceType, resourceId);
    // Turning ON the "All X" wildcard supersedes every specific grant of this
    // type — same rule as the GitHub whole-org checkbox. The specific rows then
    // render disabled ("covered by All X") so the selection stays coherent.
    if (resourceId === "*" && !existing) {
      onChange([
        ...value.filter((g) => g.resourceType !== resourceType),
        { resourceType, resourceId: "*", permissions: defaultPermissions },
      ]);
      return;
    }
    onChange(writeGrant(value, resourceType, resourceId, existing ? [] : defaultPermissions));
  };

  const togglePermission = (resourceType: ResourceType, resourceId: string, perm: Permission) => {
    const current = findGrantIn(value, resourceType, resourceId)?.permissions ?? [];
    const next = current.includes(perm)
      ? current.filter((p) => p !== perm)
      : [...current, perm];
    onChange(writeGrant(value, resourceType, resourceId, next));
  };

  /** Replace a row's permissions outright — the level control's writer. */
  const setPermissions = (resourceType: ResourceType, resourceId: string, perms: Permission[]) => {
    onChange(writeGrant(value, resourceType, resourceId, perms));
  };

  const filteredCatalog = useMemo(() => {
    if (!search.trim()) return catalog;
    const q = search.trim().toLowerCase();
    return catalog.filter((c) => c.label.toLowerCase().includes(q));
  }, [catalog, search]);

  // When the "All X" wildcard is selected, the specific rows are covered by it —
  // render them disabled so the user can't pick a redundant subset. Never while
  // the wildcard row is suppressed: its checkbox is the only way to clear it, so
  // an unclearable "covered by All X" would disable the whole list for good.
  const wildcardActive =
    showWildcardRow && !isGithub && !!findGrantIn(value, activeTab as ResourceType, "*");

  const countForTab = (tab: TabId) =>
    tab === "github"
      ? value.filter(
          (g) =>
            g.resourceType === "github_installation" ||
            g.resourceType === "github_repository",
        ).length
      : value.filter((g) => g.resourceType === tab).length;

  return (
    <div className="space-y-4">
      {/* Resource type tabs */}
      {tabs.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {tabs.map((tab) => {
            const count = countForTab(tab);
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab)}
                disabled={disabled}
                className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-colors ${
                  activeTab === tab
                    ? "bg-primary/15 text-foreground border border-primary/40"
                    : "bg-muted/40 text-muted-foreground hover:text-foreground border border-transparent"
                }`}
              >
                {tabLabel(tab)}
                {count > 0 && (
                  <span className="ms-1.5 inline-flex items-center justify-center px-1.5 rounded-full bg-primary text-primary-foreground text-[10px] font-semibold">
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {isGithub ? (
        <GitHubTree
          value={value}
          onChange={onChange}
          defaultPermissions={defaultPermissions}
          levels={levels}
          onCatalogLoaded={onCatalogLoaded}
          disabled={disabled}
        />
      ) : (
        <>
          {/* Search */}
          {!isSingleton && (
            <div className="relative">
              <Search className="absolute start-3 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={interpolate(w.searchPlaceholder, { type: tabLabel(activeTab).toLowerCase() })}
                disabled={disabled || loading}
                className="w-full ps-9 pe-3 py-2 bg-card border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>
          )}

          {/* Catalog list */}
          <div className="rounded-xl border border-border/50 overflow-hidden max-h-[340px] overflow-y-auto divide-y divide-border/30">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              </div>
            ) : (
              <>
                {showWildcardRow && (
                  <ResourceRow
                    resourceType={activeTab as ResourceType}
                    resourceId="*"
                    label={interpolate(w.allResources, { type: tabLabel(activeTab).toLowerCase() })}
                    meta={{ wildcard: true }}
                    grant={findGrantIn(value, activeTab as ResourceType, "*")}
                    onToggleResource={toggleResource}
                    onTogglePermission={togglePermission}
                    onSetPermissions={setPermissions}
                    levels={levels}
                    disabled={disabled}
                  />
                )}
                {filteredCatalog.length === 0 ? (
                  <div className="px-4 py-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      {search.trim()
                        ? w.noMatch
                        : interpolate(w.noResourcesYet, { type: tabLabel(activeTab).toLowerCase() })}
                    </p>
                  </div>
                ) : (
                  filteredCatalog.map((entry) => (
                    <ResourceRow
                      key={entry.id}
                      resourceType={activeTab as ResourceType}
                      resourceId={entry.id}
                      label={entry.label}
                      meta={entry.meta}
                      grant={findGrantIn(value, activeTab as ResourceType, entry.id)}
                      onToggleResource={toggleResource}
                      onTogglePermission={togglePermission}
                      onSetPermissions={setPermissions}
                      levels={levels}
                      disabled={disabled || wildcardActive}
                      covered={wildcardActive}
                    />
                  ))
                )}
              </>
            )}
          </div>
        </>
      )}

      {value.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {interpolate(value.length === 1 ? w.selectedSummaryOne : w.selectedSummaryOther, {
            count: String(value.length),
          })}
        </p>
      )}
    </div>
  );
}

// ── Permission chips ────────────────────────────────────────────────────────
/**
 * read/write/admin toggles for one row. Rendered INLINE at the row's trailing
 * edge, not wrapped onto a second indented line: one line per resource keeps the
 * list scannable like a table and roughly halves its height, which is what made
 * the picker feel cramped when it lived in a 640px modal.
 */
function PermissionChips({
  perms,
  onToggle,
  disabled,
}: {
  perms: Permission[];
  onToggle: (p: Permission) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1">
      {PERMISSIONS.map((p) => {
        const active = perms.includes(p);
        return (
          <button
            key={p}
            type="button"
            onClick={onToggle.bind(null, p)}
            disabled={disabled}
            title={p}
            className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider transition-colors ${
              active
                ? "bg-primary/20 text-foreground ring-1 ring-inset ring-primary/40"
                : "bg-muted/40 text-muted-foreground/70 hover:text-foreground"
            }`}
          >
            {p}
          </button>
        );
      })}
    </div>
  );
}

/** One row's access control: named levels when the caller configured them,
 *  otherwise the read/write/admin chips. */
function GrantControl({
  levels,
  perms,
  onToggle,
  onSet,
  disabled,
}: {
  levels?: LevelsConfig;
  perms: Permission[];
  onToggle: (p: Permission) => void;
  onSet: (perms: Permission[]) => void;
  disabled?: boolean;
}) {
  if (levels) {
    return (
      <LevelSwitch
        options={levels.options}
        value={levels.resolve(perms)}
        disabled={disabled}
        onChange={(id) => onSet(levels.toPermissions(id))}
        // Default (md) on purpose — no `size="sm"`. This sits directly beside
        // SourceAccessButton on the same row, and `sm` made the two read as
        // different scales (10px with tighter padding, vs 11px), which looks like a
        // bug rather than a hierarchy. The two controls are peers: one picks the
        // verb, the other the surface. They share one size.
      />
    );
  }
  return <PermissionChips perms={perms} onToggle={onToggle} disabled={disabled} />;
}

// ── Flat catalog row ─────────────────────────────────────────────────────────
function ResourceRow({
  resourceType,
  resourceId,
  label,
  meta,
  grant,
  onToggleResource,
  onTogglePermission,
  onSetPermissions,
  levels,
  disabled,
  covered,
}: {
  resourceType: ResourceType;
  resourceId: string;
  label: string;
  meta?: Record<string, unknown>;
  grant: PickerGrant | undefined;
  onToggleResource: (rt: ResourceType, rid: string) => void;
  onTogglePermission: (rt: ResourceType, rid: string, p: Permission) => void;
  onSetPermissions: (rt: ResourceType, rid: string, perms: Permission[]) => void;
  levels?: LevelsConfig;
  disabled?: boolean;
  /** True when an "All X" wildcard is selected — this specific row is redundant
   *  and shown dimmed + non-interactive. */
  covered?: boolean;
}) {
  const { t } = useI18n();
  const w = t.widgets.permissions.resourcePicker;
  const checked = !!grant;
  const isWildcard = resourceId === "*";

  return (
    <div
      className={`px-4 py-2.5 transition-colors ${
        checked ? "bg-primary/5" : covered ? "opacity-50" : "hover:bg-muted/20"
      }`}
    >
      <div className="flex items-center gap-3">
        <Checkbox checked={checked} disabled={disabled} onClick={() => onToggleResource(resourceType, resourceId)} />
        <div className="flex-1 min-w-0">
          <p className={`text-sm font-medium truncate ${isWildcard ? "text-foreground/90" : "text-foreground"}`}>
            {label}
            {isWildcard && (
              <span className="ms-2 text-[10px] font-medium uppercase tracking-wider text-primary">
                {w.wildcard}
              </span>
            )}
            {covered && !isWildcard && (
              <span className="ms-2 text-[10px] font-medium normal-case tracking-normal text-muted-foreground">
                {w.coveredByAll}
              </span>
            )}
          </p>
          {meta && Object.keys(meta).filter((k) => k !== "wildcard").length > 0 && (
            <p className="text-[11px] text-muted-foreground font-mono truncate">
              {Object.entries(meta)
                .filter(([k]) => k !== "wildcard")
                .map(([k, v]) => `${k}: ${String(v)}`)
                .join(" · ")}
            </p>
          )}
        </div>
        {checked && !covered && (
          <GrantControl
            levels={levels}
            perms={grant?.permissions ?? []}
            onToggle={(p) => onTogglePermission(resourceType, resourceId, p)}
            onSet={(perms) => onSetPermissions(resourceType, resourceId, perms)}
            disabled={disabled}
          />
        )}
      </div>
    </div>
  );
}

function Checkbox({
  checked,
  disabled,
  onClick,
}: {
  checked: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      role="checkbox"
      aria-checked={checked}
      className={`size-5 rounded border-2 flex items-center justify-center transition-colors shrink-0 disabled:opacity-40 ${
        checked
          ? "bg-primary border-primary text-primary-foreground"
          : "border-border/60 hover:border-primary/60"
      }`}
    >
      {checked && <Check className="size-3" />}
    </button>
  );
}

// ── GitHub org → repo tree ────────────────────────────────────────────────────
/**
 * Entry point to the source-access modal, on both the org row and the repo row.
 *
 * The label doubles as state: deploy-only is the DEFAULT, so a neutral "configure"
 * affordance would make the safe default look identical to an unconfigured one.
 * Saying which tier is active is the whole point — an operator scanning the list
 * needs to see at a glance which repos can be read.
 */
function SourceAccessButton({
  label,
  active,
  title,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  // IS a LevelSwitch with one segment, rather than a pill that copies its look.
  // Reproducing the classes by hand is how the two controls drifted apart in the
  // first place (10px vs 11px, different padding) — delegating means there is one
  // definition of a row control's size, and they cannot diverge again.
  //
  // `value` is the segment id when active and "" when not, so the inactive segment
  // renders in LevelSwitch's own unselected style.
  // The icon is what makes this read as a CONTROL. As a bare word it looked like a
  // static state label next to the real switch — nothing suggested it opened
  // anything, so the whole feature was invisible. Sliders + a tooltip naming the
  // action fix that without breaking the shared shell.
  return (
    <LevelSwitch
      options={[
        {
          id: SOURCE_SEGMENT,
          title,
          label: (
            <span className="inline-flex items-center gap-1">
              <SlidersHorizontal className="size-3 shrink-0" />
              {label}
            </span>
          ),
        },
      ]}
      value={active ? SOURCE_SEGMENT : ""}
      disabled={disabled}
      onChange={onClick}
    />
  );
}

/** Segment id for the single-option source-access switch. */
const SOURCE_SEGMENT = "source";

function GitHubTree({
  value,
  onChange,
  defaultPermissions,
  levels,
  onCatalogLoaded,
  disabled,
}: {
  value: PickerGrant[];
  onChange: (v: PickerGrant[]) => void;
  defaultPermissions: Permission[];
  levels?: LevelsConfig;
  onCatalogLoaded?: (type: ResourceType, entries: CatalogEntry[]) => void;
  disabled?: boolean;
}) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const w = t.widgets.permissions.resourcePicker;
  const sa = t.widgets.permissions.sourceAccess;
  /**
   * What the source-access modal is editing, or null when it's shut.
   *
   * Both widths are valid targets: an org-wide grant can carry a scope ("read
   * `src/**` in every repo under this account") exactly as a single repo can, and
   * `resolveSourceAccess` resolves whichever grant is most specific. This has to
   * cover the org row, because the default consent template grants ORG-level
   * access — with a whole-org grant active the repo rows collapse to "covered by
   * the org-wide grant", so a repo-only entry point would be unreachable.
   */
  const [sourceTarget, setSourceTarget] = useState<{
    type: "github_installation" | "github_repository";
    id: string;
    label: string;
  } | null>(null);
  const [orgs, setOrgs] = useState<CatalogEntry[]>([]);
  const [loadingOrgs, setLoadingOrgs] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reposByOwner, setReposByOwner] = useState<Record<string, CatalogEntry[]>>({});
  const [loadingRepos, setLoadingRepos] = useState<Set<string>>(new Set());
  const [repoSearch, setRepoSearch] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoadingOrgs(true);
    permissionsApi
      .listResources("github_installation")
      .then((res) => {
        if (cancelled) return;
        setOrgs(res.data ?? []);
        onCatalogLoaded?.("github_installation", res.data ?? []);
      })
      .catch((err) => {
        if (!cancelled) showToast(getApiErrorMessage(err, w.failedLoadOrgs), "error", "Picker");
      })
      .finally(() => {
        if (!cancelled) setLoadingOrgs(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  const orgGrant = (login: string) => findGrantIn(value, "github_installation", login);
  const repoGrant = (fullName: string) => findGrantIn(value, "github_repository", fullName);

  const toggleOrg = (login: string) => {
    const existing = orgGrant(login);
    let next = writeGrant(value, "github_installation", login, existing ? [] : defaultPermissions);
    if (!existing) {
      // Whole-org supersedes any specific repo grants under it.
      const lower = login.toLowerCase();
      next = next.filter(
        (g) =>
          !(
            g.resourceType === "github_repository" &&
            g.resourceId.split("/")[0]?.toLowerCase() === lower
          ),
      );
    }
    onChange(next);
  };

  const loadRepos = useCallback(
    async (login: string) => {
      if (reposByOwner[login]) return;
      setLoadingRepos((prev) => new Set(prev).add(login));
      try {
        const res = await permissionsApi.listResources("github_repository", login);
        setReposByOwner((prev) => ({ ...prev, [login]: res.data ?? [] }));
      } catch (err) {
        showToast(getApiErrorMessage(err, interpolate(w.failedLoadRepos, { login })), "error", "Picker");
        setReposByOwner((prev) => ({ ...prev, [login]: [] }));
      } finally {
        setLoadingRepos((prev) => {
          const n = new Set(prev);
          n.delete(login);
          return n;
        });
      }
    },
    [reposByOwner, showToast],
  );

  const toggleExpand = (login: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(login)) n.delete(login);
      else {
        n.add(login);
        void loadRepos(login);
      }
      return n;
    });
  };

  if (loadingOrgs) {
    return (
      <div className="rounded-xl border border-border/50 flex items-center justify-center py-10">
        <Loader2 className="size-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (orgs.length === 0) {
    return (
      <div className="rounded-xl border border-border/50 px-4 py-8 text-center">
        <p className="text-sm text-muted-foreground">{w.noOrgs}</p>
      </div>
    );
  }

  return (
    <>
    <div className="rounded-xl border border-border/50 overflow-hidden max-h-[380px] overflow-y-auto divide-y divide-border/30">
      {orgs.map((org) => {
        const login = org.id;
        const grant = orgGrant(login);
        const wholeOrg = !!grant;
        const isOpen = expanded.has(login);
        const repos = reposByOwner[login] ?? [];
        const q = (repoSearch[login] ?? "").trim().toLowerCase();
        const shownRepos = q ? repos.filter((r) => r.label.toLowerCase().includes(q)) : repos;
        const repoCount = value.filter(
          (g) =>
            g.resourceType === "github_repository" &&
            g.resourceId.split("/")[0]?.toLowerCase() === login.toLowerCase(),
        ).length;

        return (
          <div key={login}>
            {/* Org row */}
            <div className={`px-3 py-2.5 ${wholeOrg ? "bg-primary/5" : "hover:bg-muted/20"} transition-colors`}>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => toggleExpand(login)}
                  disabled={disabled}
                  className="p-0.5 rounded text-muted-foreground hover:text-foreground disabled:opacity-40"
                  aria-label={isOpen ? w.collapse : w.expand}
                >
                  {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4 rtl:rotate-180" />}
                </button>
                <Checkbox checked={wholeOrg} disabled={disabled} onClick={() => toggleOrg(login)} />
                <ResourceAvatar resourceType="github_installation" resourceId={login} className="size-5" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground truncate">
                    {org.label}
                    <span className="ms-2 text-[11px] text-muted-foreground">
                      {wholeOrg
                        ? w.entireOrg
                        : repoCount > 0
                          ? interpolate(repoCount === 1 ? w.repoCountOne : w.repoCountOther, { count: String(repoCount) })
                          : ""}
                    </span>
                  </p>
                </div>
                {wholeOrg && (
                  <SourceAccessButton
                    label={grant?.scope ? sa.tierContent : sa.tierDeploy}
                    active={!!grant?.scope}
                    title={sa.buttonHint}
                    disabled={disabled}
                    onClick={() =>
                      setSourceTarget({
                        type: "github_installation",
                        id: login,
                        label: org.label,
                      })
                    }
                  />
                )}
                {wholeOrg && (
                  <GrantControl
                    levels={levels}
                    perms={grant?.permissions ?? []}
                    onToggle={(p) => {
                      const cur = grant?.permissions ?? [];
                      onChange(
                        writeGrant(
                          value,
                          "github_installation",
                          login,
                          cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p],
                        ),
                      );
                    }}
                    onSet={(perms) =>
                      onChange(writeGrant(value, "github_installation", login, perms))
                    }
                    disabled={disabled}
                  />
                )}
              </div>
            </div>

            {/* Repos under this org */}
            {isOpen && (
              <div className="bg-muted/[0.03] border-t border-border/20">
                {wholeOrg ? (
                  <p className="px-12 py-3 text-xs text-muted-foreground italic">
                    {w.coveredByOrg}
                  </p>
                ) : loadingRepos.has(login) ? (
                  <div className="flex items-center justify-center py-6">
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  </div>
                ) : repos.length === 0 ? (
                  <p className="px-12 py-4 text-xs text-muted-foreground">{w.noRepos}</p>
                ) : (
                  <>
                    {repos.length > 8 && (
                      <div className="px-10 pt-2 pb-1">
                        <input
                          type="text"
                          value={repoSearch[login] ?? ""}
                          onChange={(e) => setRepoSearch((prev) => ({ ...prev, [login]: e.target.value }))}
                          placeholder={w.searchRepos}
                          disabled={disabled}
                          className="w-full px-3 py-1.5 bg-card border border-border/50 rounded-lg text-xs text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
                        />
                      </div>
                    )}
                    {shownRepos.map((repo) => {
                      const rg = repoGrant(repo.id);
                      const checked = !!rg;
                      return (
                        <div
                          key={repo.id}
                          className={`ps-12 pe-4 py-2.5 ${checked ? "bg-primary/5" : "hover:bg-muted/20"} transition-colors`}
                        >
                          <div className="flex items-center gap-3">
                            <Checkbox
                              checked={checked}
                              disabled={disabled}
                              onClick={() =>
                                onChange(
                                  writeGrant(
                                    value,
                                    "github_repository",
                                    repo.id,
                                    checked ? [] : defaultPermissions,
                                  ),
                                )
                              }
                            />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm text-foreground truncate">
                                {repo.label.split("/")[1] ?? repo.label}
                              </p>
                            </div>
                            {checked && (
                              <SourceAccessButton
                                label={rg?.scope ? sa.tierContent : sa.tierDeploy}
                                active={!!rg?.scope}
                                title={sa.buttonHint}
                                disabled={disabled}
                                onClick={() =>
                                  setSourceTarget({
                                    type: "github_repository",
                                    id: repo.id,
                                    label: repo.label,
                                  })
                                }
                              />
                            )}
                            {checked && (
                              <GrantControl
                                levels={levels}
                                perms={rg?.permissions ?? []}
                                onToggle={(p) => {
                                  const cur = rg?.permissions ?? [];
                                  onChange(
                                    writeGrant(
                                      value,
                                      "github_repository",
                                      repo.id,
                                      cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p],
                                    ),
                                  );
                                }}
                                onSet={(perms) =>
                                  onChange(writeGrant(value, "github_repository", repo.id, perms))
                                }
                                disabled={disabled}
                              />
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>

    {/* Source access is its own dedicated surface rather than more chips on the
        row: it carries three tiers, two path lists and a summary, and it is the
        difference between "may deploy this repo" and "may read its source". */}
    {sourceTarget && (() => {
      const current = findGrantIn(value, sourceTarget.type, sourceTarget.id);
      return (
        <Modal
          isOpen
          onClose={() => setSourceTarget(null)}
          // Wide, and `overflow="hidden"` so the TREE scrolls inside its column
          // rather than the whole panel growing until the footer leaves the screen.
          // Same shape as the app's other browse-and-choose modals.
          // Size is driven by the panel's own content, not fixed here: only
          // SourceAccessModal knows the tier, and it animates its width when you
          // move from Deploy only (narrow, no columns) into a browse tier (wide,
          // two columns). Passing a width here would freeze it at one of the two.
          width="auto"
          maxWidth="95vw"
          maxHeight="86vh"
          overflow="hidden"
          showCloseButton={false}
        >
          <SourceAccessModal
            open
            onClose={() => setSourceTarget(null)}
            targetLabel={sourceTarget.label}
            wholeAccount={sourceTarget.type === "github_installation"}
            permissions={current?.permissions ?? []}
            scope={current?.scope}
            onApply={(scope) =>
              onChange(
                writeGrant(
                  value,
                  sourceTarget.type,
                  sourceTarget.id,
                  // Keep the verb exactly as it was — this modal edits the SURFACE
                  // only. Falling back to defaultPermissions would quietly widen a
                  // target the owner had set to read-only.
                  current?.permissions ?? defaultPermissions,
                  scope ?? null,
                ),
              )
            }
          />
        </Modal>
      );
    })()}
    </>
  );
}
