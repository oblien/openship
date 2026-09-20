import type { OrganizationOptions } from "better-auth/plugins/organization";
import { APIError } from "better-auth/api";
import { defaultStatements, adminAc, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { createAccessControl } from "better-auth/plugins/access";
import { repos } from "@repo/db";
import { env, runtimeTargetId } from "../config/env";
import { resolveDashboardPublicUrl, refreshSelfAppPublicUrl } from "./public-url";
import { sendMail, smtpEnabled } from "./mail";
import { organizationInviteEmail } from "./email-templates";
import { memberAudit } from "../modules/audit/member-emitter";
import { getOrgBillingState } from "../modules/billing/billing-org-cleanup";
import { invitationClaimPath, safeErrorMessage } from "@repo/core";
import { invitationNeedsEmail } from "./invitation-delivery";
import { invitationAccountCreationMode } from "./invitation-claim";
import { trackBackgroundWork } from "./background-work";

export const isSaasDeployment = runtimeTargetId === "cloud-saas" || env.CLOUD_MODE;

/**
 * Better Auth organization-plugin access control config.
 *
 * We register a fourth role, `restricted`, with no default permissions —
 * its access is granted exclusively via resource_grant rows and enforced
 * by apps/api/src/lib/permission.ts.
 *
 * IMPORTANT: passing a custom `ac` (needed to declare `restricted`) opts
 * OUT of Better Auth's built-in owner/admin/member roles. They are NOT
 * kept automatically — if we don't re-declare them every org role ends up
 * with ZERO permissions (an owner can't even invite a member). So we pass
 * the plugin's own default role ACs (`ownerAc`/`adminAc`/`memberAc`, built
 * from the same `defaultStatements`) back in alongside `restricted`.
 */
const ORG_ACCESS_CONTROLLER = createAccessControl(defaultStatements);
// Restricted role: explicitly no plugin-side permissions on org-management
// endpoints (member CRUD, invitation, team). Our own permission.ts
// resolver gates everything else via resource_grant rows. The `newRole`
// generic infers `K extends never` for an empty statements arg, which
// breaks the `Role<any>` constraint on `roles` — so we declare with
// `ac: []` (zero actions on a real key) to land a usable Role type.
const RESTRICTED_ROLE = ORG_ACCESS_CONTROLLER.newRole({ ac: [] });

/**
 * Per-inviter rate limit on the Better Auth organization plugin's
 * invite-member flow. Counts invitations created by this user across all
 * orgs in the last hour; rejects the create if the user is already at or
 * above the cap. Wired in `beforeCreateInvitation` below.
 */
export const INVITE_RATE_LIMIT_PER_HOUR = 50;
export const INVITE_RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

export const organizationOptions = {
  allowUserToCreateOrganization: true,
  organizationLimit: 10, // per-user cap on org creation
  membershipLimit: 100, // per-org cap on member count
  creatorRole: "owner",
  invitationExpiresIn: 60 * 60 * 24 * 7, // 7 days
  /**
   * Custom role registration. Better Auth's organization plugin
   * normally only accepts owner/admin/member in update-member-role
   * + invite-member endpoints. We register a fourth role,
   * `restricted`, as a no-default-permissions baseline. Resource-
   * level access is granted via the resource_grant table + checked
   * by apps/api/src/lib/permission.ts — the Better Auth role
   * itself just carries the label.
   */
  ac: ORG_ACCESS_CONTROLLER,
  roles: {
    // Re-declare the built-in roles with their default permissions —
    // custom `ac` above wipes them otherwise (see the block comment).
    // `restricted` carries no plugin permissions; permission.ts gates it
    // via resource_grant rows.
    owner: ownerAc,
    admin: adminAc,
    member: memberAc,
    restricted: RESTRICTED_ROLE,
  },
  sendInvitationEmail: smtpEnabled
    ? async (data, request) => {
        if (invitationNeedsEmail(request)) await deliverOrganizationInvitation(data);
      }
    : undefined,

  /**
   * Lifecycle hooks for the org/member/invitation tables.
   *
   * - `beforeCreateInvitation` enforces a per-inviter rate limit
   *   (50 invitations / hour across all orgs) by throwing an APIError
   *   that the plugin surfaces back to the client as a 429.
   * - The `after*` hooks emit forensic audit rows via the
   *   member-emitter wrapper. We use synchronous `audit.record` for
   *   these since losing a member-mutation row is a security gap.
   *
   * Hooks fire OUTSIDE the Hono request cycle so we can't attach
   * IP/UA — the emitter writes them as null. The `actorUserId` is
   * the user the plugin says triggered the event.
   */
  organizationHooks: {
    beforeCreateInvitation: async ({ invitation, inviter }) => {
      // Any organization — personal OR team — may invite members. The
      // is_team flag now only LABELS the workspace (a user's auto-created
      // personal workspace vs a separately-created team org); it no longer
      // gates invites. A user can share their personal workspace directly,
      // and creating a team org stays an optional, separate path. We still
      // require an orgId so every invitation is org-scoped.
      const orgId = invitation.organizationId;
      if (!orgId) {
        throw new APIError("BAD_REQUEST", {
          message: "organizationId is required to create an invitation",
          code: "INVITE_MISSING_ORG",
        });
      }

      // Self-hosted account creation is invite-only. An org admin may still
      // invite an EXISTING instance user, but only an INSTANCE admin may
      // invite a new email that will mint a new account. Enforce this when
      // the invitation is created so we never email an unusable link; the
      // claim endpoint repeats the role check as defense in depth because
      // the inviter's role can change before the link is opened.
      if (!isSaasDeployment) {
        const existingInvitee = await repos.user.findByEmail(invitation.email);
        const instanceInviter = existingInvitee
          ? undefined
          : await repos.user.findById(inviter.id);
        const creationMode = invitationAccountCreationMode({
          accountExists: !!existingInvitee,
          isSaas: false,
          inviterIsInstanceAdmin: instanceInviter?.role === "admin",
        });
        if (creationMode === "disabled") {
          throw new APIError("FORBIDDEN", {
            message:
              "Only an instance administrator can invite someone who does not yet have an account.",
            code: "INVITE_NEW_ACCOUNT_REQUIRES_INSTANCE_ADMIN",
          });
        }
      }

      const since = new Date(Date.now() - INVITE_RATE_LIMIT_WINDOW_MS);
      const recent = await repos.invitation.countByInviterSince(inviter.id, since);
      if (recent >= INVITE_RATE_LIMIT_PER_HOUR) {
        throw new APIError("TOO_MANY_REQUESTS", {
          message: `Invitation rate limit reached (${INVITE_RATE_LIMIT_PER_HOUR}/hour). Try again later.`,
        });
      }
      // No data override — return void to keep the plugin's defaults.
      void invitation;
    },

    afterCreateOrganization: async ({ organization, user, member }) => {
      await memberAudit.emit(
        { organizationId: organization.id, actorUserId: user.id },
        {
          eventType: "organization.created",
          resourceType: "organization",
          resourceId: organization.id,
          after: {
            name: organization.name,
            slug: organization.slug,
            creatorMemberId: member.id,
            creatorRole: member.role,
          },
        },
      );

      // Create the org namespace under the provider's default billing policy.
      // Cloud only, and fire-and-forget: a slow or unreachable Oblien must
      // not fail org creation (the boot backfill re-attempts anything that
      // fails here). Without this a free org had no namespace recorded and
      // therefore no credit quota and no resource ceiling — metered,
      // joinable, and uncapped.
      if (env.CLOUD_MODE) {
        trackBackgroundWork(import("../modules/billing/billing-namespace.provision")
          .then(({ provisionOrgNamespace }) => provisionOrgNamespace(organization.id))
          .catch((err) =>
            console.warn(
              `[auth] namespace provisioning failed for org ${organization.id}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          ));
      }
    },

    beforeDeleteOrganization: async ({ organization, user }) => {
      if (await repos.serverCluster.hasManagedNetworkState(organization.id)) {
        throw new APIError("CONFLICT", {
          message: "Remove managed cluster networks and complete network recovery before deleting this organization.",
          code: "ORG_DELETE_MANAGED_NETWORK_ACTIVE",
        });
      }
      // Pre-flight billing gate. Better Auth commits the org delete
      // immediately after this hook returns — afterDelete only gets
      // to fire forensic cleanup, not block. So the only place we
      // can reject an org-delete with the billing still live is
      // here. Throws propagate out of the plugin as the 4xx the
      // APIError describes (crud-org.mjs awaits this hook without
      // try/catch).
      const billingState = await getOrgBillingState(organization.id);
      if (billingState.blocking) {
        // Audit FIRST so the rejection is observable even if the
        // attacker scripts a flood of delete attempts — every one
        // leaves a row. memberAudit.emit swallows its own errors,
        // so we don't risk the audit-write itself blocking the
        // rejection it's recording.
        await memberAudit.emit(
          { organizationId: organization.id, actorUserId: user.id },
          {
            eventType: "organization.deletion.blocked",
            resourceType: "organization",
            resourceId: organization.id,
            after: {
              activeSubscriptionCount: billingState.activeSubscriptionCount,
              openInvoiceCount: billingState.openInvoiceCount,
              openInvoiceAmountCents: billingState.openInvoiceAmountCents,
              summary: billingState.summary,
            },
          },
        );
        throw new APIError("CONFLICT", {
          message: billingState.summary,
          code: "ORG_DELETE_BILLING_ACTIVE",
        });
      }

      // HIGH F16: snapshot the membership BEFORE Better Auth's
      // CASCADE wipes the member rows. The afterDelete hook needs
      // these for the audit summary and for sanity-checking the
      // session re-point downstream.
      try {
        const members = await repos.member.listByOrganization(organization.id);
        (organization as { _orgDeleteMemberSnapshot?: unknown })._orgDeleteMemberSnapshot =
          members.map((m) => ({
            userId: m.userId,
            role: m.role,
          }));
      } catch (err) {
        console.warn(
          "[organizationHooks.beforeDeleteOrganization] member snapshot failed:",
          safeErrorMessage(err),
        );
      }
    },

    afterDeleteOrganization: async ({ organization, user }) => {
      // Cloud/legacy billing accounts are blocked before deletion. Only local
      // grants and session pointers remain to clean up after this commit.
      const memberSnapshot =
        (organization as { _orgDeleteMemberSnapshot?: unknown })._orgDeleteMemberSnapshot ??
        null;

      let grantsDeleted = 0;
      try {
        grantsDeleted = await repos.resourceGrant.deleteByOrganization(organization.id);
      } catch (err) {
        console.error("[organizationHooks.afterDeleteOrganization] grant cleanup failed:", err);
      }

      let sessionsRepointed = 0;
      try {
        sessionsRepointed = await repos.session.clearActiveOrganizationId(organization.id);
      } catch (err) {
        console.error(
          "[organizationHooks.afterDeleteOrganization] session re-point failed:",
          err,
        );
      }

      await memberAudit.emit(
        { organizationId: organization.id, actorUserId: user.id },
        {
          eventType: "organization.deleted",
          resourceType: "organization",
          resourceId: organization.id,
          before: {
            name: organization.name,
            slug: organization.slug,
            members: memberSnapshot,
          },
          after: {
            grantsDeleted,
            sessionsRepointed,
          },
        },
      );
    },

    afterAddMember: async ({ member, user, organization }) => {
      await memberAudit.emit(
        { organizationId: organization.id, actorUserId: user.id },
        {
          eventType: "member.added",
          resourceType: "member",
          resourceId: member.id,
          after: {
            userId: member.userId,
            role: member.role,
          },
        },
      );
    },

    afterRemoveMember: async ({ member, user, organization }) => {
      // Revoke this member's resource_grant rows on the way out so
      // re-adding them later (e.g. as a fresh restricted member)
      // can't silently inherit prior-tenure access. The permission
      // resolver short-circuits on missing membership, so a
      // stale-grant condition is security-inert in practice — but
      // we audit cleanup failures so the condition is observable
      // instead of just console-logged.
      try {
        await repos.resourceGrant.deleteByMember(organization.id, member.userId);
      } catch (err) {
        const message = safeErrorMessage(err);
        console.error("[organizationHooks.afterRemoveMember] grant cleanup failed:", err);
        await memberAudit.emit(
          { organizationId: organization.id, actorUserId: user.id },
          {
            eventType: "member.removal.grant_cleanup_failed",
            resourceType: "member",
            resourceId: member.id,
            after: { userId: member.userId, errorMessage: message.slice(0, 500) },
          },
        );
      }

      // Delete this member's notification_subscription rows for the org.
      // Unlike resource_grants (inert once membership is gone), subscriptions
      // are read by the background dispatcher purely on (org, category,
      // enabled) with NO membership check, and the member's channel is
      // per-user so it survives removal — so a leftover subscription keeps
      // streaming this org's events to a removed member indefinitely. Best-
      // effort + audited, same as the grant cleanup above.
      try {
        await repos.notificationSubscription.deleteAllForMember(member.userId, organization.id);
      } catch (err) {
        const message = safeErrorMessage(err);
        console.error(
          "[organizationHooks.afterRemoveMember] subscription cleanup failed:",
          err,
        );
        await memberAudit.emit(
          { organizationId: organization.id, actorUserId: user.id },
          {
            eventType: "member.removal.subscription_cleanup_failed",
            resourceType: "member",
            resourceId: member.id,
            after: { userId: member.userId, errorMessage: message.slice(0, 500) },
          },
        );
      }

      await memberAudit.emit(
        { organizationId: organization.id, actorUserId: user.id },
        {
          eventType: "member.removed",
          resourceType: "member",
          resourceId: member.id,
          before: {
            userId: member.userId,
            role: member.role,
          },
        },
      );
    },

    afterUpdateMemberRole: async ({ member, previousRole, user, organization }) => {
      await memberAudit.emit(
        { organizationId: organization.id, actorUserId: user.id },
        {
          eventType: "member.role_changed",
          resourceType: "member",
          resourceId: member.id,
          before: { role: previousRole },
          after: { role: member.role, userId: member.userId },
        },
      );
    },

    afterCreateInvitation: async ({ invitation, inviter, organization }) => {
      await memberAudit.emit(
        { organizationId: organization.id, actorUserId: inviter.id },
        {
          eventType: "invitation.created",
          resourceType: "invitation",
          resourceId: invitation.id,
          after: {
            email: invitation.email,
            role: invitation.role,
            status: invitation.status,
          },
        },
      );
    },

    afterAcceptInvitation: async ({ invitation, user, organization, member }) => {
      await memberAudit.emit(
        { organizationId: organization.id, actorUserId: user.id },
        {
          eventType: "invitation.accepted",
          resourceType: "invitation",
          resourceId: invitation.id,
          after: {
            email: invitation.email,
            role: invitation.role,
            memberId: member.id,
          },
        },
      );
    },

    afterRejectInvitation: async ({ invitation, user, organization }) => {
      // Better Auth marks the invitation status=rejected but keeps
      // the row — its CASCADE doesn't fire, so any pending grants
      // we stored for this invite would linger as zombies. Wipe them.
      await repos.invitationPendingGrant
        .deleteByInvitation(invitation.id)
        .catch((err: unknown) =>
          console.error("[afterRejectInvitation] pending-grant cleanup failed:", err),
        );

      await memberAudit.emit(
        { organizationId: organization.id, actorUserId: user.id },
        {
          eventType: "invitation.rejected",
          resourceType: "invitation",
          resourceId: invitation.id,
          before: {
            email: invitation.email,
            role: invitation.role,
          },
        },
      );
    },

    afterCancelInvitation: async ({ invitation, cancelledBy, organization }) => {
      // Same rationale as reject — pending grants on a canceled
      // invitation become zombie rows otherwise.
      await repos.invitationPendingGrant
        .deleteByInvitation(invitation.id)
        .catch((err: unknown) =>
          console.error("[afterCancelInvitation] pending-grant cleanup failed:", err),
        );

      await memberAudit.emit(
        { organizationId: organization.id, actorUserId: cancelledBy.id },
        {
          eventType: "invitation.cancelled",
          resourceType: "invitation",
          resourceId: invitation.id,
          before: {
            email: invitation.email,
            role: invitation.role,
          },
        },
      );
    },
  },
} satisfies OrganizationOptions;

/** Shared delivery implementation for the authentication provider and native operations. */
export async function deliverOrganizationInvitation(data: Parameters<NonNullable<OrganizationOptions["sendInvitationEmail"]>>[0]): Promise<void> {
        // Link-only is still Better Auth's normal, authorized invitation
        // write; it merely skips transport so a self-hosted operator with
        // no SMTP/cloud relay can copy the pending link from Team settings.

        // Use the instance's PUBLIC url so the accept link works from the
        // invitee's browser (a VPS/self-host box's real domain), not the
        // static loopback default. Falls back to the runtime-target dashboard
        // when no public url is configured (pure localhost dev).
        // Freshen the DB-derived self-app URL so the link uses the domain the
        // operator added in the Domains tab (no restart needed). Env
        // --public-url seed still wins inside resolveDashboardPublicUrl.
        await refreshSelfAppPublicUrl().catch(() => {});
        const inviteBase = resolveDashboardPublicUrl();
        const inviteUrl = `${inviteBase}${invitationClaimPath(data.id)}`;
        const email = organizationInviteEmail({
          invitee: { email: data.email },
          inviter: { name: data.inviter.user.name, email: data.inviter.user.email },
          organizationName: data.organization.name,
          url: inviteUrl,
        });

        // Per-instance source toggle. Default is "platform" — keep
        // invites on our own SMTP identity. Operators on a
        // cloud-only deployment can flip to "cloud" so the relay
        // through /api/cloud/send-invitation on the SaaS owns
        // delivery (sends from the SaaS's own mail infrastructure).
        //
        // The DB read is per-invite — invitations are rare and the
        // round-trip lets operators flip the toggle without
        // bouncing the API.
        const settings = await repos.instanceSettings.get();
        const source = settings?.invitationMailSource === "cloud" ? "cloud" : "platform";

        const delivered = await sendMail({
          to: data.email,
          preferSource: source,
          // organizationId is required by lib/mail.ts when
          // preferSource === "cloud" on a local instance — the
          // cloudClient uses it to resolve the org owner's cloud
          // session token. Harmless on the platform path.
          organizationId: data.organization.id,
          ...email,
        });
        // An invite that cannot be delivered must not report success: the invitee
        // has a pending row and no way to learn about it, and the inviter believes
        // it went out. `sendMail` only warns on an empty chain, so this is the only
        // place that can tell. Throwing surfaces it on the invite request itself.
        if (!delivered) {
          throw new APIError("SERVICE_UNAVAILABLE", {
            message:
              `Could not email the invitation to ${data.email} — this instance has ` +
              `no working email transport. Configure SMTP in Settings → Email and ` +
              `invite again.`,
          });
        }
}
