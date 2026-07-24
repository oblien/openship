"use client";

/**
 * Members page — list, invite, manage roles, remove members in the
 * active organization.
 *
 * Backed by Better Auth's organization plugin endpoints:
 *   GET    /api/auth/organization/list-members
 *   POST   /api/auth/organization/invite-member
 *   POST   /api/auth/organization/update-member-role
 *   POST   /api/auth/organization/remove-member
 *
 * All accessible via the authClient.organization.* methods.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Mail, Plus, Trash2, UserPlus, Building2, LogOut, Settings2 } from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { useToast } from "@/context/ToastContext";
import {
  api,
  ApiError,
  getApiErrorMessage,
  isNetworkError,
  permissionsApi,
  type PickerGrant,
  type ResourceGrant,
  type ResourceType,
} from "@/lib/api";
import { useModal } from "@/context/ModalContext";
import { GrantPickerModal } from "./GrantPickerModal";
import { InviteMemberModal } from "./InviteMemberModal";
import { serversNewlyGranted, hasNewServerGrant, confirmServerAccess } from "@/components/permissions/confirm-server-access";
import { usePlatform } from "@/context/PlatformContext";
import { useCloud } from "@/context/CloudContext";
import { TeamWorkspaceCard } from "./TeamWorkspaceCard";
import { TeamReachabilityCard, type TeamReachability } from "./TeamReachabilityCard";
import { WorkspaceManageModal } from "./WorkspaceManageModal";
import { useI18n, interpolate } from "@/components/i18n-provider";

type MemberRole = "owner" | "admin" | "member" | "restricted";

// ResourceType / PickerGrant / ResourceGrant / resourceTypeLabel are the shared
// definitions from @/lib/api (imported above).

interface MemberRow {
  id: string;
  userId: string;
  role: MemberRole;
  createdAt: string;
  user: { id: string; name: string; email: string; image?: string | null };
}

interface InvitationRow {
  id: string;
  email: string;
  role: MemberRole;
  status: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Better Auth's React client wraps `authClient.organization` in a Proxy
 * whose property accesses return fresh references. Putting that proxy
 * (or any value derived from it) into a `useEffect` / `useCallback`
 * dependency array explodes into an infinite render loop:
 *
 *   render → new ref → useCallback rebuilds → useEffect re-fires
 *   → fetch → setState → render → ...
 *
 * Resolving the client ONCE at module load avoids the trap. Imports of
 * this module evaluate before any React tree mounts, so the captured
 * reference is stable for the lifetime of the page.
 */
const orgClient = (authClient as unknown as {
  organization: {
    listMembers: () => Promise<{ data?: { members?: MemberRow[] } }>;
    listInvitations: () => Promise<{ data?: InvitationRow[] }>;
    inviteMember: (opts: { email: string; role: MemberRole }) => Promise<{ error?: { message?: string } }>;
    removeMember: (opts: { memberIdOrEmail: string }) => Promise<{ error?: { message?: string } }>;
    updateMemberRole: (opts: { memberId: string; role: MemberRole }) => Promise<{ error?: { message?: string } }>;
    cancelInvitation: (opts: { invitationId: string }) => Promise<{ error?: { message?: string } }>;
    leave: (opts: { organizationId: string }) => Promise<{ error?: { message?: string } }>;
    setActive: (opts: { organizationId: string }) => Promise<unknown>;
    getFullOrganization: () => Promise<{ data?: { id: string; name: string } | null }>;
  };
}).organization;

export function TeamTab() {
  const { data: session } = useSession();
  const { showToast } = useToast();
  const { t } = useI18n();
  const { showModal, hideModal } = useModal();
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [invitations, setInvitations] = useState<InvitationRow[]>([]);
  const [loading, setLoading] = useState(true);

  // Per-instance invitation mail source, loaded from /api/system/settings and
  // passed to the invite modal as its initial value (the modal owns changes).
  type InvitationMailSource = "platform" | "cloud";
  const [invitationMailSource, setInvitationMailSource] =
    useState<InvitationMailSource>("platform");
  // Source-of-truth for "is this instance reachable + where" — drives the smart
  // invite gate + inline guidance (loaded from /system/settings).
  const [reachability, setReachability] = useState<TeamReachability | null>(null);
  const { selfHosted } = usePlatform();
  // Read here (inside CloudProvider) and passed into the invite modal, which is
  // rendered by the root-level modal host outside the dashboard providers.
  const { connected: cloudConnected, startConnect: connectCloud } = useCloud();

  // Mode-aware grantable types: servers + mail servers are self-hosted-only;
  // billing exists only in cloud (SaaS). The picker collapses the two GitHub
  // types into one tab.
  const availableTypes: ResourceType[] = selfHosted
    ? ["project", "server", "mail_server", "backup_destination", "audit", "github_installation", "github_repository"]
    : ["project", "backup_destination", "billing", "audit", "github_installation", "github_repository"];

  // Org-meta: drives personal-vs-team UX. Personal workspaces (auto-
  // created on signup) hide the invite UI; clicking "Create team org"
  // spawns a brand-new is_team=true org with the same owner.
  const [orgMeta, setOrgMeta] = useState<{ isTeam: boolean; memberCount: number; organizationId?: string } | null>(null);
  const [createTeamOpen, setCreateTeamOpen] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [creatingTeam, setCreatingTeam] = useState(false);
  const [activeOrgName, setActiveOrgName] = useState("");
  const [manageOpen, setManageOpen] = useState(false);

  // In-flight guard. React Strict Mode mounts every component twice in
  // dev to surface non-idempotent effects — without this ref the refresh
  // effect fires two parallel fetches on every page load. The ref flips
  // true at the start of a refresh and resets in `finally`, so retries
  // after errors still work, but the StrictMode remount no-ops.
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setLoading(true);
    try {
      const [mRes, iRes, metaRes, settingsRes, fullRes] = await Promise.all([
        orgClient.listMembers(),
        orgClient.listInvitations(),
        // org-meta drives the personal-vs-team UX. The backend ensures
        // a row exists for every org, so this always resolves.
        api.get<{ data: { isTeam: boolean; memberCount: number; organizationId?: string } }>(
          "permissions/org-meta",
        ).catch(() => ({ data: { isTeam: false, memberCount: 0 } })),
        api
          .get<{
            invitationMailSource?: InvitationMailSource;
            teamReachability?: TeamReachability;
          }>("system/settings")
          .catch(() => ({ invitationMailSource: "platform" as InvitationMailSource })),
        // Active org name for the manage-workspace modal (rename default + confirm).
        orgClient.getFullOrganization().catch(() => ({ data: null })),
      ]);
      setMembers(mRes.data?.members ?? []);
      setInvitations(iRes.data ?? []);
      setOrgMeta(metaRes.data);
      setActiveOrgName((fullRes.data as { name?: string } | null)?.name ?? "");
      // SaaS has no self-hosted mail server — invites always go via cloud and
      // the "Send via" chooser is hidden, so only honor a stored source when
      // self-hosted.
      const src = settingsRes?.invitationMailSource;
      if (!selfHosted) {
        setInvitationMailSource("cloud");
      } else if (src === "platform" || src === "cloud") {
        setInvitationMailSource(src);
      }
      setReachability((settingsRes as { teamReachability?: TeamReachability })?.teamReachability ?? null);
    } catch (err) {
      // Network/abort errors are handled by the global NetworkErrorHandler;
      // only surface real API errors here so we don't double-toast.
      console.error("Failed to load members", err);
      if (err instanceof ApiError || !isNetworkError(err)) {
        showToast(getApiErrorMessage(err, t.settings.team.toast.loadFailed), "error", t.settings.common.toast.team);
      }
    } finally {
      setLoading(false);
      refreshingRef.current = false;
    }
  }, [showToast, selfHosted, t]);

  const handleCreateTeam = async () => {
    const name = newTeamName.trim();
    if (!name) {
      showToast(t.settings.team.toast.teamNameRequired, "error", t.settings.common.toast.team);
      return;
    }
    setCreatingTeam(true);
    try {
      const res = await api.post<{ data: { id: string; name: string } }>(
        "permissions/create-team-org",
        { name },
      );
      const newOrgId = res.data?.id;
      if (!newOrgId) throw new Error("No org id returned");
      showToast(interpolate(t.settings.team.toast.teamCreated, { name }), "success", t.settings.common.toast.team);
      setCreateTeamOpen(false);
      setNewTeamName("");
      // Switch the active org to the new one via Better Auth, then reload.
      try {
        const setActive = (
          authClient as unknown as {
            organization: {
              setActive: (opts: { organizationId: string }) => Promise<unknown>;
            };
          }
        ).organization.setActive;
        await setActive({ organizationId: newOrgId });
      } catch {
        /* fall through — page reload picks up the new org */
      }
      // Force a reload so every context (sidebar, header) picks up the
      // new active org cleanly.
      if (typeof window !== "undefined") {
        window.location.reload();
      }
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.team.toast.createFailed), "error", t.settings.common.toast.team);
    } finally {
      setCreatingTeam(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Open the invite flow via the centralized modal hook (blurred, centered).
  const openInvite = () => {
    let id = "";
    id = showModal({
      // The content owns its own width (narrow single-column, or wide two-pane
      // when "Restricted" is picked); cap the shell so it never clips.
      maxWidth: "95vw",
      showCloseButton: false,
      customContent: (
        <InviteMemberModal
          availableTypes={availableTypes}
          selfHosted={selfHosted}
          initialMailSource={invitationMailSource}
          cloudConnected={cloudConnected}
          onConnectCloud={connectCloud}
          onInvited={() => void refresh()}
          onClose={() => hideModal(id)}
        />
      ),
    });
  };

  const handleRoleChange = async (memberId: string, role: MemberRole) => {
    const res = await orgClient.updateMemberRole({ memberId, role });
    if (res.error) {
      showToast(res.error.message ?? t.settings.team.toast.updateRoleFailed, "error", t.settings.common.toast.members);
      return;
    }
    await refresh();
  };

  const handleRemove = async (memberIdOrEmail: string) => {
    if (!confirm(t.settings.team.confirmRemove)) return;
    const res = await orgClient.removeMember({ memberIdOrEmail });
    if (res.error) {
      showToast(res.error.message ?? t.settings.team.toast.removeFailed, "error", t.settings.common.toast.members);
      return;
    }
    await refresh();
  };

  const handleCancelInvite = async (invitationId: string) => {
    const res = await orgClient.cancelInvitation({ invitationId });
    if (res.error) {
      showToast(res.error.message ?? t.settings.team.toast.cancelFailed, "error", t.settings.common.toast.invitations);
      return;
    }
    await refresh();
  };

  // Delete/leave switch back to the personal workspace first — you can't sit on
  // an org that no longer exists (or that you just left).
  const switchToPersonalAndReload = async () => {
    const personalOrgId = session?.user?.id ? `org_${session.user.id}` : null;
    try {
      if (personalOrgId) await orgClient.setActive({ organizationId: personalOrgId });
    } catch {
      /* the reload resolves whatever org remains */
    }
    if (typeof window !== "undefined") window.location.reload();
  };

  const handleLeaveWorkspace = async () => {
    const orgId = orgMeta?.organizationId;
    if (!orgId) return;
    if (!confirm(t.settings.team.workspace.leaveConfirm)) return;
    const res = await orgClient.leave({ organizationId: orgId });
    if (res.error) {
      showToast(res.error.message ?? t.settings.team.toast.leaveFailed, "error", t.settings.common.toast.team);
      return;
    }
    showToast(t.settings.team.toast.left, "success", t.settings.common.toast.team);
    await switchToPersonalAndReload();
  };

  // Open the resource-access editor for a member: load their current grants,
  // then show the shared picker modal (blurred, centered) prefilled with them.
  // Save replaces the whole set (server diffs add/change/remove).
  const openMemberPanel = useCallback(
    async (m: MemberRow) => {
      if (m.role === "owner") return;
      let initial: PickerGrant[] = [];
      try {
        const res = await permissionsApi.listGrants(m.userId);
        initial = (res.data ?? []).map((g: ResourceGrant) => ({
          resourceType: g.resourceType,
          resourceId: g.resourceId,
          permissions: g.permissions,
        }));
      } catch (err) {
        showToast(getApiErrorMessage(err, t.settings.team.toast.loadGrantsFailed), "error", t.settings.common.toast.permissions);
        return;
      }
      let id = "";
      id = showModal({
        maxWidth: "640px",
        showCloseButton: false,
        customContent: (
          <GrantPickerModal
            title={m.user.name || m.user.email}
            subtitle={t.settings.team.memberPanel.subtitle}
            initial={initial}
            availableTypes={availableTypes}
            saveLabel={t.settings.team.memberPanel.saveLabel}
            onSave={async (grants) => {
              // Warn before newly granting server access — it exposes all data,
              // apps, and connected integrations on that server. Throwing keeps
              // the picker open (its onSave contract) when the owner backs out.
              const delta = serversNewlyGranted(initial, grants);
              if (hasNewServerGrant(delta)) {
                const w = t.settings.team.serverAccessWarning;
                const scope = delta.wildcard
                  ? w.scopeAllServers
                  : delta.ids.length === 1
                    ? w.scopeThisServer
                    : interpolate(w.scopeCount, { count: String(delta.ids.length) });
                const ok = await confirmServerAccess({
                  showModal,
                  hideModal,
                  title: w.title,
                  message: interpolate(w.body, { member: m.user.name || m.user.email, scope }),
                  confirmLabel: w.confirm,
                  cancelLabel: t.settings.common.cancel,
                });
                if (!ok) throw new Error("server-access-declined");
              }
              await permissionsApi.replaceGrants(m.userId, grants);
              showToast(t.settings.team.toast.accessUpdated, "success", t.settings.common.toast.permissions);
            }}
            onClose={() => hideModal(id)}
          />
        ),
      });
    },
    [availableTypes, showModal, hideModal, showToast, t],
  );

  const myMembership = members.find((m) => m.userId === session?.user?.id);
  const isOwner = myMembership?.role === "owner";
  const isAdminOrOwner = myMembership?.role === "owner" || myMembership?.role === "admin";

  // Tri-state org kind: loading | personal | team. Render the invite
  // button ONLY when team is confirmed; render the "Create team" banner
  // ONLY when personal is confirmed. Anything else (initial null, fetch
  // failure) shows nothing — better than flashing a button that the
  // server would reject with "you are not allowed to invite".
  const orgKind: "loading" | "personal" | "team" =
    orgMeta === null ? "loading" : orgMeta.isTeam ? "team" : "personal";
  const isPersonalOrg = orgKind === "personal";

  // Offer "Invite member" whenever it can actually succeed. The backend now
  // allows inviting to a personal OR team org (is_team only labels the
  // workspace — see auth.ts beforeCreateInvitation), so the only real block is
  // a self-hosted single-user instance: no shared location, no multi-user auth,
  // so a teammate couldn't reach it. There we hide the button and show the
  // "shared location" hint (TeamWorkspaceCard) instead of a dead action.
  // Smart gate: invites are allowed once the instance is actually REACHABLE
  // (a real public URL — env `--public-url` or the Openship app's verified
  // domain), not gated on the migration-wizard flag. So adding a domain to the
  // Openship app turns invites on directly.
  const canInvite = isAdminOrOwner && (!selfHosted || !!reachability?.configured);

  // Not reachable yet (self-hosted, no public URL) → show inline guidance
  // (add a domain to Openship / install it) + the migrate-elsewhere option,
  // instead of a dead-ended invite button.
  const showWorkspaceMigration = selfHosted && !reachability?.configured;

  // Delete/leave apply to a TEAM workspace only — never the personal workspace
  // (org_<userId>), which is the account base. Owner deletes; a member leaves.
  const isTeamOrg = orgMeta?.isTeam === true;
  const canManageWorkspace = isOwner && isTeamOrg && !!orgMeta?.organizationId;
  const canLeaveWorkspace = !isOwner && isTeamOrg && !!orgMeta?.organizationId;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            className="text-xl font-medium text-foreground/80"
            style={{ letterSpacing: "-0.2px" }}
          >
            {t.settings.team.heading}
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            {isPersonalOrg
              ? t.settings.team.descPersonal
              : t.settings.team.descTeam}
          </p>
        </div>
        {canInvite && (
          <button
            type="button"
            onClick={openInvite}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <UserPlus className="size-4" />
            {t.settings.team.inviteMember}
          </button>
        )}
      </div>

      {/* Personal workspaces can't invite directly (the invite button is hidden
          for them — the server rejects personal-org invites). Spinning up a
          separate team org is the path to collaborating, so this card carries
          it — owner only. */}
      {isPersonalOrg && isOwner && (
        <div className="rounded-xl border border-border/50 bg-transparent p-4 flex items-center gap-3">
          <div className="size-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
            <Building2 className="size-[18px] text-muted-foreground" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">{t.settings.team.createTeamCard.title}</p>
            <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
              {t.settings.team.createTeamCard.body}
            </p>
          </div>
          <button
            type="button"
            onClick={() => setCreateTeamOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/60 bg-transparent px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted/40 hover:text-foreground transition-colors shrink-0"
          >
            <Plus className="size-3.5" />
            {t.settings.team.createTeamCard.button}
          </button>
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Active members */}
          <div className="rounded-2xl border border-border/50 bg-card sadwq">
            <div className="px-5 py-3 border-b border-border/50 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-foreground">
                {interpolate(t.settings.team.activeMembers, { count: String(members.length) })}
              </h2>
            </div>
            <div className="divide-y divide-border/40">
              {members.map((m) => {
                const clickable = m.role !== "owner";
                return (
                  <div
                    key={m.id}
                    role={clickable ? "button" : undefined}
                    tabIndex={clickable ? 0 : undefined}
                    onClick={clickable ? () => void openMemberPanel(m) : undefined}
                    onKeyDown={
                      clickable
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void openMemberPanel(m);
                            }
                          }
                        : undefined
                    }
                    className={`px-5 py-4 flex items-center gap-4 ${
                      clickable ? "cursor-pointer hover:bg-muted/30 transition-colors" : ""
                    }`}
                  >
                    <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center text-sm font-medium text-foreground">
                      {(m.user.name || m.user.email).slice(0, 1).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">
                        {m.user.name || m.user.email}
                        {m.userId === session?.user?.id && (
                          <span className="ms-2 text-xs text-muted-foreground">{t.settings.team.you}</span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground truncate">{m.user.email}</p>
                    </div>
                    {isOwner && m.userId !== session?.user?.id ? (
                      <select
                        value={m.role}
                        onChange={(e) => handleRoleChange(m.id, e.target.value as MemberRole)}
                        onClick={(e) => e.stopPropagation()}
                        className="text-xs rounded-lg border border-border/50 bg-card px-2 py-1.5 text-foreground"
                      >
                        <option value="owner">{t.settings.team.roles.owner}</option>
                        <option value="admin">{t.settings.team.roles.admin}</option>
                        <option value="member">{t.settings.team.roles.member}</option>
                        <option value="restricted">{t.settings.team.roles.restricted}</option>
                      </select>
                    ) : (
                      <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                        {m.role}
                      </span>
                    )}
                    {isAdminOrOwner && m.userId !== session?.user?.id && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRemove(m.id);
                        }}
                        className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                        title={t.settings.team.removeMember}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Pending invitations */}
          {invitations.length > 0 && (
            <div className="rounded-2xl border border-border/50 bg-card sadwq">
              <div className="px-5 py-3 border-b border-border/50">
                <h2 className="text-sm font-semibold text-foreground">
                  {interpolate(t.settings.team.pendingInvitations, { count: String(invitations.filter((i) => i.status === "pending").length) })}
                </h2>
              </div>
              <div className="divide-y divide-border/40">
                {invitations
                  .filter((i) => i.status === "pending")
                  .map((inv) => (
                    <div key={inv.id} className="px-5 py-4 flex items-center gap-4">
                      <div className="w-9 h-9 rounded-full bg-muted flex items-center justify-center">
                        <Mail className="size-4 text-muted-foreground" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-foreground truncate">{inv.email}</p>
                        <p className="text-xs text-muted-foreground">
                          {interpolate(t.settings.team.invitedAs, { role: inv.role, date: new Date(inv.expiresAt).toLocaleDateString() })}
                        </p>
                      </div>
                      {isAdminOrOwner && (
                        <button
                          type="button"
                          onClick={() => handleCancelInvite(inv.id)}
                          className="text-xs font-medium text-muted-foreground hover:text-destructive transition-colors"
                        >
                          {t.settings.common.cancel}
                        </button>
                      )}
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Workspace actions on a TEAM workspace — the owner opens the
              manage modal (rename / pause / delete); a member can leave.
              Hidden for the personal workspace (the account base). */}
          {(canManageWorkspace || canLeaveWorkspace) && (
            <div className="flex items-center justify-between gap-4 rounded-2xl border border-border/50 bg-card p-5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">
                  {canManageWorkspace
                    ? t.settings.team.workspace.manage.title
                    : t.settings.team.workspace.leaveWorkspace}
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {canManageWorkspace
                    ? t.settings.team.workspace.manage.sectionBody
                    : t.settings.team.workspace.leaveBody}
                </p>
              </div>
              {canManageWorkspace ? (
                <button
                  type="button"
                  onClick={() => setManageOpen(true)}
                  className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-border/60 bg-transparent px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-muted/50"
                >
                  <Settings2 className="size-4" />
                  {t.settings.team.workspace.manage.title}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void handleLeaveWorkspace()}
                  className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/10"
                >
                  <LogOut className="size-4" />
                  {t.settings.team.workspace.leaveWorkspace}
                </button>
              )}
            </div>
          )}
        </>
      )}

      {/* Not reachable yet: inline guidance (add a domain to Openship / install
          it) is the primary path; the migrate-elsewhere card is the alternative.
          Last in the tab so the members UI leads. */}
      {showWorkspaceMigration && (
        <>
          <TeamReachabilityCard reachability={reachability} />
          <TeamWorkspaceCard canMigrate={!!isOwner} />
        </>
      )}

      {/* Owner-only manage modal: rename, pause all projects, or delete the
          workspace (tears each project down before removing the org). */}
      {manageOpen && orgMeta?.organizationId && (
        <WorkspaceManageModal
          organizationId={orgMeta.organizationId}
          organizationName={activeOrgName}
          onClose={() => setManageOpen(false)}
          onRenamed={(n) => {
            setActiveOrgName(n);
            void refresh();
          }}
          onDeleted={() => void switchToPersonalAndReload()}
        />
      )}

      {/* Create Team org modal — Cloudflare-style separate account
          creation. Spawns a fresh org with is_team=true; user becomes
          owner. After creation we setActive() to it and reload so the
          whole app picks up the new active org. */}
      {createTeamOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-6"
          onClick={() => !creatingTeam && setCreateTeamOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border/50 bg-card p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className="size-9 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
                <Building2 className="size-4 text-primary" />
              </div>
              <div>
                <h3 className="text-lg font-semibold text-foreground">{t.settings.team.createTeamModal.title}</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  {t.settings.team.createTeamModal.body}
                </p>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-foreground block mb-1.5">{t.settings.team.createTeamModal.teamName}</label>
              <input
                type="text"
                value={newTeamName}
                onChange={(e) => setNewTeamName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newTeamName.trim()) {
                    void handleCreateTeam();
                  }
                }}
                placeholder={t.settings.team.createTeamModal.placeholder}
                autoFocus
                disabled={creatingTeam}
                className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setCreateTeamOpen(false)}
                disabled={creatingTeam}
                className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
              >
                {t.settings.common.cancel}
              </button>
              <button
                type="button"
                onClick={handleCreateTeam}
                disabled={creatingTeam || !newTeamName.trim()}
                className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
              >
                {creatingTeam && <Loader2 className="size-4 animate-spin" />}
                {t.settings.team.createTeamModal.createTeam}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

