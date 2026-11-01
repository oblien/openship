"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { Icon } from "@repo/ui/icons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs } from "@/components/ui/Tabs";
import DropdownMenu from "@/components/ui/DropdownMenu";
import { OptionCard } from "@/components/shared/OptionCard";
import { systemApi } from "@/lib/api/system";
import {
  api,
  getApiErrorMessage,
  permissionsApi,
  type PickerGrant,
  type ResourceType,
} from "@/lib/api";
import { invitationShareUrl } from "@/lib/invitation-flow";
import { ResourcePicker } from "@/components/permissions/ResourcePicker";
import {
  serversNewlyGranted,
  hasNewServerGrant,
  confirmServerAccess,
} from "@/components/permissions/confirm-server-access";
import { useModal } from "@/context/ModalContext";
import { useI18n, interpolate } from "@/components/i18n-provider";

type MemberRole = "admin" | "member" | "restricted";

/** Both delivery choices use the existing invitation/grant operation. Mail
 * configuration belongs to the instance; copying a link needs no transport. */
export function InviteMemberInline({
  availableTypes,
  selfHosted,
  initialMailSource,
  cloudConnected,
  instanceUrl,
  onConnectCloud,
  onInvited,
  onClose,
}: {
  availableTypes: ResourceType[];
  selfHosted: boolean;
  initialMailSource: "platform" | "cloud";
  cloudConnected: boolean;
  instanceUrl: string | null;
  onConnectCloud: () => void;
  onInvited: () => void;
  onClose: () => void;
}) {
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const copy = t.settings.inviteMember;
  const fieldId = useId();
  const deliveryId = useId();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>("member");
  const [grants, setGrants] = useState<PickerGrant[]>([]);
  const [delivery, setDelivery] = useState<"email" | "link" | null>(null);
  const [emailDeliverable, setEmailDeliverable] = useState<boolean | null>(null);
  const [mailSource, setMailSource] = useState(initialMailSource);
  const [savingMailSource, setSavingMailSource] = useState(false);
  const [inviting, setInviting] = useState(false);
  const submitting = useRef(false);
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ url: string; email: string; linkOnly: boolean } | null>(
    null,
  );
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!selfHosted) return;
    let active = true;
    systemApi
      .getEmailSettings()
      .then((settings) => {
        if (active) setEmailDeliverable(settings.deliverable);
      })
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/app/(dashboard)/settings/_components/InviteMemberInline");
        if (active) setEmailDeliverable(false);
      });
    return () => {
      active = false;
    };
  }, [selfHosted]);

  const canEmail = !selfHosted || (mailSource === "cloud" ? cloudConnected : emailDeliverable);
  const linkOnly = (delivery ?? (canEmail === true ? "email" : "link")) === "link";
  const roles = [
    { key: "member", icon: "users", title: copy.roleMemberTitle, description: copy.roleMemberDesc },
    { key: "admin", icon: "shield", title: copy.roleAdminTitle, description: copy.roleAdminDesc },
    {
      key: "restricted",
      icon: "lock",
      title: copy.roleRestrictedTitle,
      description: copy.roleRestrictedDesc,
    },
  ] as const;

  async function changeMailSource(next: "platform" | "cloud") {
    if (next === mailSource || savingMailSource || submitting.current) return;
    setSavingMailSource(true);
    setError("");
    try {
      await api.patch("system/settings", { invitationMailSource: next });
      setMailSource(next);
    } catch (err) {
      setError(getApiErrorMessage(err, copy.toast.updateMailSourceFailed));
    } finally {
      setSavingMailSource(false);
    }
  }

  async function handleInvite(event: FormEvent) {
    event.preventDefault();
    if (submitting.current || savingMailSource || !email.trim() || (!linkOnly && canEmail !== true))
      return;
    submitting.current = true;
    setInviting(true);
    setError("");
    try {
      // Check shareability before creating an invitation; no localhost fallback.
      invitationShareUrl(instanceUrl, "preview");
      const selectedGrants = role === "restricted" ? grants : [];
      const delta = serversNewlyGranted([], selectedGrants);
      if (hasNewServerGrant(delta)) {
        const warning = t.settings.team.serverAccessWarning;
        const scope = delta.wildcard
          ? warning.scopeAllServers
          : delta.ids.length === 1
            ? warning.scopeThisServer
            : interpolate(warning.scopeCount, { count: String(delta.ids.length) });
        if (
          !(await confirmServerAccess({
            showModal,
            hideModal,
            title: warning.title,
            message: interpolate(warning.body, { member: email.trim(), scope }),
            confirmLabel: warning.confirm,
            cancelLabel: t.settings.common.cancel,
          }))
        )
          return;
      }
      const result = await permissionsApi.inviteWithGrants(
        { email: email.trim(), role, grants: selectedGrants },
        { linkOnly },
      );
      setCreated({
        url: invitationShareUrl(instanceUrl, result.data.id),
        email: result.data.email,
        linkOnly,
      });
      onInvited();
    } catch (err) {
      setError(getApiErrorMessage(err, copy.toast.failedSend));
      // Delivery can fail after the pending invitation commits. Refresh the
      // existing list so its copy/revoke controls remain reachable.
      onInvited();
    } finally {
      submitting.current = false;
      setInviting(false);
    }
  }

  if (created) {
    return (
      <div className="space-y-4 rounded-2xl bg-card p-5" role="status">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-success/10 text-success">
            <Icon name={created.linkOnly ? "link" : "send"} className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">
              {created.linkOnly ? copy.linkReady : copy.emailSent}
            </h3>
            <p className="mt-1 break-words text-sm text-muted-foreground">
              {interpolate(copy.recipientHint, { email: created.email })}
            </p>
          </div>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            variant="filled"
            value={created.url}
            readOnly
            dir="ltr"
            aria-label={copy.invitationLink}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 text-xs"
          />
          <Button
            variant="secondary"
            className="shrink-0"
            onClick={() => {
              void navigator.clipboard
                .writeText(created.url)
                .then(() => {
                  setCopied(true);
                  setError("");
                })
                .catch((diagnosticFailure) => { observeCaughtError(diagnosticFailure, "dashboard/app/(dashboard)/settings/_components/InviteMemberInline"); return setError(t.settings.team.toast.copyInviteFailed); });
            }}
          >
            <Icon name={copied ? "check" : "copy"} className="size-4" />
            {copied ? t.settings.common.copied : t.settings.team.copyInviteLink}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{copy.manageLinkHint}</p>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex justify-end">
          <Button onClick={onClose}>{t.settings.common.done}</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-5 rounded-2xl bg-card p-5"
      onSubmit={(event) => void handleInvite(event)}
    >
      <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <div className="space-y-5">
          <div className="space-y-2">
            <label className="block text-sm font-medium" htmlFor={fieldId}>
              {copy.email}
            </label>
            <Input
              id={fieldId}
              variant="filled"
              type="email"
              value={email}
              autoComplete="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder={copy.emailPlaceholder}
              disabled={inviting}
              required
              maxLength={254}
              dir="ltr"
            />
          </div>
          <fieldset className="min-w-0 space-y-2" disabled={inviting}>
            <legend className="mb-2 text-sm font-medium">{copy.delivery}</legend>
            <Tabs
              tabs={[
                { key: "email", label: copy.emailDelivery, icon: "send" },
                { key: "link", label: copy.linkDelivery, icon: "link" },
              ]}
              value={linkOnly ? "link" : "email"}
              onChange={setDelivery}
              idPrefix={deliveryId}
              ariaLabel={copy.delivery}
              columns={2}
              size="sm"
            />
            <div
              role="tabpanel"
              id={`${deliveryId}-panel-email`}
              aria-labelledby={`${deliveryId}-tab-email`}
              hidden={linkOnly}
            >
              <p className="text-xs leading-relaxed text-muted-foreground">
                {copy.emailDeliveryHint}
              </p>
              {selfHosted && (
                <DropdownMenu
                  align="left"
                  disabled={inviting || savingMailSource}
                  triggerLabel={copy.sendVia}
                  className="mt-2 inline-block"
                  triggerClassName="inline-flex items-center gap-1.5 rounded-lg py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  trigger={
                    <>
                      <Icon name={mailSource === "cloud" ? "cloud" : "send"} className="size-3.5" />
                      {mailSource === "cloud" ? copy.openshipCloud : copy.yourMailServer}
                      <Icon name="chevron-down" className="size-3" />
                    </>
                  }
                  actions={[
                    {
                      id: "platform",
                      label: copy.yourMailServer,
                      icon: <Icon name="send" className="size-4" />,
                      onClick: () => void changeMailSource("platform"),
                    },
                    {
                      id: "cloud",
                      label: copy.openshipCloud,
                      icon: <Icon name="cloud" className="size-4" />,
                      onClick: () => void changeMailSource("cloud"),
                    },
                  ]}
                />
              )}
            </div>
            <div
              role="tabpanel"
              id={`${deliveryId}-panel-link`}
              aria-labelledby={`${deliveryId}-tab-link`}
              hidden={!linkOnly}
            >
              <p className="text-xs leading-relaxed text-muted-foreground">
                {copy.linkDeliveryHint}
              </p>
            </div>
            {selfHosted && canEmail !== true && (
              <p className="text-xs leading-relaxed text-muted-foreground">
                {canEmail === null ? copy.checkingEmail : copy.emailUnavailable}{" "}
                {canEmail === false &&
                  (mailSource === "cloud" ? (
                    <button
                      type="button"
                      onClick={onConnectCloud}
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      {copy.connectCloud}
                    </button>
                  ) : (
                    <Link
                      href="/settings?tab=email"
                      className="font-medium text-foreground underline underline-offset-2"
                    >
                      {copy.setUpEmail}
                    </Link>
                  ))}
              </p>
            )}
          </fieldset>
        </div>
        <fieldset className="min-w-0">
          <legend className="mb-2 text-sm font-medium">{copy.role}</legend>
          <div className="grid gap-2">
            {roles.map((item) => (
              <OptionCard
                key={item.key}
                value={item.key}
                selected={role === item.key}
                disabled={inviting}
                onSelect={() => {
                  setRole(item.key);
                  if (item.key !== "restricted") setGrants([]);
                }}
                icon={<Icon name={item.icon} className="size-4" />}
                label={item.title}
                description={item.description}
              />
            ))}
          </div>
        </fieldset>
      </div>
      {role === "restricted" && (
        <div className="space-y-3 border-t border-border/50 pt-5">
          <div>
            <h4 className="text-sm font-semibold">{copy.pickerTitle}</h4>
            <p className="mt-1 text-xs text-muted-foreground">{copy.pickerDesc}</p>
          </div>
          <ResourcePicker
            value={grants}
            onChange={setGrants}
            availableTypes={availableTypes}
            defaultPermissions={["read"]}
            disabled={inviting}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" onClick={onClose} disabled={inviting}>
          {t.settings.common.cancel}
        </Button>
        <Button
          type="submit"
          disabled={
            inviting ||
            savingMailSource ||
            !email.trim() ||
            !instanceUrl ||
            (!linkOnly && canEmail !== true)
          }
        >
          <Icon
            name={inviting ? "spinner" : linkOnly ? "link" : "send"}
            className={inviting ? "animate-spin" : ""}
          />
          {linkOnly ? copy.createInviteLink : copy.sendInvite}
        </Button>
      </div>
    </form>
  );
}
