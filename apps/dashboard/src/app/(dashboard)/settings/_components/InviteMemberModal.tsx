"use client";

/**
 * Self-contained content for the "Invite a member" modal — rendered via the
 * centralized `showModal` hook (blurred, centered Modal shell). Owns all its
 * own state (email, role, mail source, initial grants) so it stays reactive
 * inside showModal's snapshotted customContent. Calls `onInvited` after a
 * successful send and `onClose` to dismiss.
 */

import { useState, useEffect } from "react";
import Link from "next/link";
import { Loader2, Users as UsersIcon, Shield, Lock, Send, Cloud, AlertTriangle } from "lucide-react";
import { authClient } from "@/lib/auth-client";
import { useToast } from "@/context/ToastContext";
import { systemApi } from "@/lib/api/system";
import {
  api,
  getApiErrorMessage,
  permissionsApi,
  type PickerGrant,
  type ResourceType,
} from "@/lib/api";
import { ResourcePicker } from "@/components/permissions/ResourcePicker";
import { useModal } from "@/context/ModalContext";
import { serversNewlyGranted, hasNewServerGrant, confirmServerAccess } from "@/components/permissions/confirm-server-access";
import { useI18n, interpolate } from "@/components/i18n-provider";

type MemberRole = "owner" | "admin" | "member" | "restricted";
type MailSource = "platform" | "cloud";

const orgClient = (authClient as unknown as {
  organization: {
    inviteMember: (opts: { email: string; role: MemberRole }) => Promise<{ error?: { message?: string } }>;
  };
}).organization;

export function InviteMemberModal({
  availableTypes,
  selfHosted,
  initialMailSource,
  cloudConnected,
  onConnectCloud,
  onInvited,
  onClose,
}: {
  availableTypes: ResourceType[];
  selfHosted: boolean;
  initialMailSource: MailSource;
  /** Cloud state is passed in (not read via useCloud) because this content is
   *  rendered by the ROOT-level modal host, outside the dashboard's CloudProvider. */
  cloudConnected: boolean;
  onConnectCloud: () => void;
  onInvited: () => void;
  onClose: () => void;
}) {
  const { showToast } = useToast();
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [grants, setGrants] = useState<PickerGrant[]>([]);
  const [mailSource, setMailSource] = useState<MailSource>(initialMailSource);
  const [savingMailSource, setSavingMailSource] = useState(false);
  const [inviting, setInviting] = useState(false);

  // Can the selected transport actually deliver the invite email?
  //   - "platform" (your mail system) → the instance can send (SMTP / mail
  //     server / env). null = unknown (not yet loaded / no read access).
  //   - "cloud" → Openship Cloud is connected to relay it (passed in as a prop).
  const [emailDeliverable, setEmailDeliverable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!selfHosted) return;
    let cancelled = false;
    systemApi
      .getEmailSettings()
      .then((r) => {
        if (!cancelled) setEmailDeliverable(!!r.deliverable);
      })
      .catch(() => {
        if (!cancelled) setEmailDeliverable(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selfHosted]);

  // Block send when the chosen transport can't deliver — the invite link would
  // never reach the person. Only blocks on a KNOWN-bad state (never on unknown).
  const transportBlocked =
    selfHosted &&
    ((mailSource === "platform" && emailDeliverable === false) ||
      (mailSource === "cloud" && !cloudConnected));

  const changeMailSource = async (next: MailSource) => {
    if (next === mailSource) return;
    const prev = mailSource;
    setMailSource(next);
    setSavingMailSource(true);
    try {
      await api.patch("system/settings", { invitationMailSource: next });
    } catch (err) {
      setMailSource(prev);
      showToast(getApiErrorMessage(err, t.settings.inviteMember.toast.updateMailSourceFailed), "error", t.settings.common.toast.settings);
    } finally {
      setSavingMailSource(false);
    }
  };

  const handleInvite = async () => {
    if (!email.trim()) return;
    setInviting(true);
    try {
      if (role === "restricted" && grants.length > 0) {
        // Warn before inviting with server access — at invite time every server
        // grant is new, so diff against an empty set.
        const delta = serversNewlyGranted([], grants);
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
            message: interpolate(w.body, { member: email.trim(), scope }),
            confirmLabel: w.confirm,
            cancelLabel: t.settings.common.cancel,
          });
          if (!ok) return;
        }
        await permissionsApi.inviteWithGrants({ email: email.trim(), role, grants });
      } else {
        const res = await orgClient.inviteMember({ email: email.trim(), role });
        if (res.error) {
          showToast(res.error.message ?? t.settings.inviteMember.toast.failedSend, "error", t.settings.common.toast.invitation);
          return;
        }
      }
      showToast(interpolate(t.settings.inviteMember.toast.invitationSent, { email }), "success", t.settings.common.toast.invitation);
      onInvited();
      onClose();
    } catch (err) {
      showToast(getApiErrorMessage(err, t.settings.inviteMember.toast.failedSend), "error", t.settings.common.toast.invitation);
    } finally {
      setInviting(false);
    }
  };

  const restricted = role === "restricted";

  // Left column (single-column body when not restricted): email, role cards,
  // and the mail-source picker. Rendered as the left pane in two-pane mode.
  const formFields = (
    <>
      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground block">{t.settings.inviteMember.email}</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t.settings.inviteMember.emailPlaceholder}
          disabled={inviting}
          className="w-full px-3 py-2 bg-muted/30 border border-border/50 rounded-xl text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all"
        />
      </div>

      <div className="space-y-2">
        <label className="text-sm font-medium text-foreground block">{t.settings.inviteMember.role}</label>
        <div className="space-y-2">
          <RoleCard
            icon={UsersIcon}
            title={t.settings.inviteMember.roleMemberTitle}
            description={t.settings.inviteMember.roleMemberDesc}
            selected={role === "member"}
            disabled={inviting}
            onClick={() => {
              setRole("member");
              setGrants([]);
            }}
          />
          <RoleCard
            icon={Shield}
            title={t.settings.inviteMember.roleAdminTitle}
            description={t.settings.inviteMember.roleAdminDesc}
            selected={role === "admin"}
            disabled={inviting}
            onClick={() => {
              setRole("admin");
              setGrants([]);
            }}
          />
          <RoleCard
            icon={Lock}
            title={t.settings.inviteMember.roleRestrictedTitle}
            description={t.settings.inviteMember.roleRestrictedDesc}
            selected={restricted}
            disabled={inviting}
            onClick={() => setRole("restricted")}
            badge={
              restricted && grants.length > 0
                ? interpolate(
                    grants.length === 1 ? t.settings.inviteMember.grantsOne : t.settings.inviteMember.grantsMany,
                    { count: String(grants.length) },
                  )
                : undefined
            }
          />
        </div>
      </div>

      {/* Send via — self-hosted only (SaaS always relays via its own infra).
          A segmented switch: recessed track, raised active pill. A status dot
          per option lets you compare deliverability at a glance; a single
          contextual line below handles the active option's fix (no double
          messaging). */}
      {selfHosted && (
        <div className="space-y-2">
          <label className="text-sm font-medium text-foreground block">{t.settings.inviteMember.sendVia}</label>
          <div className="grid grid-cols-2 gap-1 rounded-xl border border-border/50 bg-muted/25 p-1">
            <SendSegment
              icon={Send}
              label={t.settings.inviteMember.yourMailServer}
              statusText={
                emailDeliverable === false
                  ? t.settings.inviteMember.mailNotSetUp
                  : emailDeliverable
                    ? t.settings.inviteMember.mailReady
                    : undefined
              }
              tone={emailDeliverable === false ? "warn" : emailDeliverable ? "ok" : "pending"}
              selected={mailSource === "platform"}
              disabled={inviting || savingMailSource}
              onClick={() => changeMailSource("platform")}
            />
            <SendSegment
              icon={Cloud}
              label={t.settings.inviteMember.openshipCloud}
              statusText={cloudConnected ? t.settings.inviteMember.cloudReady : t.settings.inviteMember.cloudNotReady}
              tone={cloudConnected ? "ok" : "warn"}
              selected={mailSource === "cloud"}
              disabled={inviting || savingMailSource}
              onClick={() => changeMailSource("cloud")}
            />
          </div>

          {mailSource === "platform" && emailDeliverable === false && (
            <p className="flex items-start gap-1.5 px-1 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.8} />
              <span>
                {t.settings.inviteMember.noMailSystem}{" "}
                <Link
                  href="/settings?tab=email"
                  onClick={onClose}
                  className="font-medium underline underline-offset-2 hover:opacity-80"
                >
                  {t.settings.inviteMember.setUpEmail}
                </Link>
              </span>
            </p>
          )}
          {mailSource === "cloud" && !cloudConnected && (
            <p className="flex items-start gap-1.5 px-1 text-xs text-warning">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.8} />
              <span>
                {t.settings.inviteMember.cloudNotConnected}{" "}
                <button
                  type="button"
                  onClick={() => onConnectCloud()}
                  className="font-medium underline underline-offset-2 hover:opacity-80"
                >
                  {t.settings.inviteMember.connectCloud}
                </button>
              </span>
            </p>
          )}
        </div>
      )}
    </>
  );

  // Right pane, restricted only: the resource picker the invite unlocks.
  const pickerPane = (
    <div className="space-y-3">
      <div>
        <h4 className="text-sm font-semibold text-foreground">{t.settings.inviteMember.pickerTitle}</h4>
        <p className="text-xs text-muted-foreground mt-1">
          {t.settings.inviteMember.pickerDesc}
        </p>
      </div>
      <ResourcePicker
        value={grants}
        onChange={setGrants}
        availableTypes={availableTypes}
        defaultPermissions={["read"]}
        disabled={inviting}
      />
    </div>
  );

  return (
    <div
      className={`flex flex-col max-h-[85vh] transition-[width,max-width] duration-300 ${
        restricted ? "w-[92vw] max-w-[1040px]" : "w-[min(92vw,560px)]"
      }`}
    >
      <div className="p-6 border-b border-border/50">
        <h3 className="text-lg font-semibold text-foreground">{t.settings.inviteMember.headerTitle}</h3>
        <p className="text-sm text-muted-foreground mt-1">
          {restricted
            ? t.settings.inviteMember.headerDescRestricted
            : t.settings.inviteMember.headerDescDefault}
        </p>
      </div>

      {restricted ? (
        <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <div className="overflow-y-auto p-6 space-y-5 md:border-e border-border/50">
            {formFields}
          </div>
          <div className="overflow-y-auto p-6">{pickerPane}</div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto p-6 space-y-5">{formFields}</div>
      )}

      <div className="flex items-center justify-end gap-2 p-6 border-t border-border/50">
        <button
          type="button"
          onClick={onClose}
          disabled={inviting}
          className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
        >
          {t.settings.common.cancel}
        </button>
        <button
          type="button"
          onClick={handleInvite}
          disabled={inviting || !email.trim() || transportBlocked}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {inviting && <Loader2 className="size-4 animate-spin" />}
          {t.settings.inviteMember.sendInvite}
        </button>
      </div>
    </div>
  );
}

/** One segment of the send-via switch. Selected = raised pill (card bg + ring +
 *  shadow) over the recessed track; unselected = flat with a hover wash. The
 *  status dot color encodes deliverability (green ready / amber needs-setup /
 *  grey unknown) so both options are comparable at a glance. */
function SendSegment({
  icon: Icon,
  label,
  statusText,
  tone,
  selected,
  disabled,
  onClick,
}: {
  icon: React.ElementType;
  label: string;
  statusText?: string;
  tone: "ok" | "warn" | "pending";
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const dotClass = tone === "ok" ? "bg-success" : tone === "warn" ? "bg-warning" : "bg-muted-foreground/40";
  const statusClass = tone === "ok" ? "text-success" : tone === "warn" ? "text-warning" : "text-muted-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-start transition-all disabled:opacity-50 ${
        selected
          ? "bg-card shadow-sm ring-1 ring-inset ring-border/70"
          : "hover:bg-foreground/[0.03]"
      }`}
    >
      <Icon
        className={`size-4 shrink-0 ${selected ? "text-primary" : "text-muted-foreground"}`}
        strokeWidth={1.8}
      />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] font-medium ${selected ? "text-foreground" : "text-muted-foreground"}`}>
          {label}
        </span>
        {statusText && (
          <span className={`mt-0.5 flex items-center gap-1 text-[11px] ${statusClass}`}>
            <span className={`size-1.5 rounded-full ${dotClass}`} />
            {statusText}
          </span>
        )}
      </span>
    </button>
  );
}

function RoleCard({
  icon: Icon,
  title,
  description,
  selected,
  disabled,
  onClick,
  badge,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  badge?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={selected}
      className={`w-full text-start flex items-start gap-3 rounded-xl border px-3.5 py-3 transition-all disabled:opacity-50 ${
        selected
          ? "border-primary/40 bg-primary/[0.06]"
          : "border-border/50 bg-muted/[0.05] hover:bg-muted/15 hover:border-border"
      }`}
    >
      <div
        className={`size-8 rounded-lg flex items-center justify-center shrink-0 ${
          selected ? "bg-primary/15 text-primary" : "bg-muted/40 text-muted-foreground"
        }`}
      >
        <Icon className="size-4" strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="text-sm font-medium text-foreground">{title}</p>
          {badge && (
            <span className="text-[11px] font-medium px-1.5 py-0.5 rounded-md bg-primary/15 text-primary">
              {badge}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">{description}</p>
      </div>
    </button>
  );
}
