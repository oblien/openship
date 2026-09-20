"use client";

/**
 * Notifications tab — "mail arrives at this address → tell me in this channel".
 *
 * Named for what an operator comes here to do. The API and the schema still call
 * these inbound rules (`mailAdminApi.inbound`, `InboundRule`) because that's what
 * the capture side of the machinery is; nobody looking for where mail alerts are
 * configured went looking under "Inbound".
 *
 * Two behaviours of that machinery are surfaced here on purpose, because both
 * would otherwise be silent:
 *
 *   - the channel picker lists only `enabled && verified` channels, and excludes `in_app`.
 *     The dispatcher drops anything unverified, and the in_app worker is a deliberate no-op
 *     with no dashboard surface reading the deliveries feed — so either would let an
 *     operator save a rule that can never deliver anything they can see.
 *   - a mailbox rule carries a caveat rather than hiding one. Postfix runs with
 *     `enable_original_recipient = no`, so a captured copy has no `X-Original-To` and can
 *     only be attributed via To/Cc: mail that arrived by Bcc or through an alias is
 *     invisible to a mailbox rule. Domain scope has no such gap.
 *
 * Channels are not created here — they live in Settings → Notifications, org-wide,
 * because everything else that notifies (jobs, deploys, health) shares them. Every
 * dead end that a missing channel produces therefore carries a link to that screen
 * instead of a sentence describing where it is.
 *
 * Same layout and primitives as the Mailboxes/Aliases tabs (DataTable + StatusPill +
 * FormModalContent), so this reads as one panel rather than a bolt-on.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Bell, Pencil, Plus, Trash2, FlaskConical } from "lucide-react";
import {
  getApiErrorMessage,
  mailAdminApi,
  notificationsApi,
  type InboundRule,
  type InboundScope,
  type NotificationChannel,
} from "@/lib/api";
import { Checkbox } from "@/components/ui/Checkbox";
import { ChannelLogo } from "@/components/ui/ChannelLogo";
import { Choice } from "@/components/ui/Choice";
import { useModal } from "@/context/ModalContext";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { DataTable, RowActionsMenu, type DataTableColumn } from "./_shared/data-table";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { StatusPill } from "./_shared/status-pill";
import { Field, FormModalContent, inputClassName } from "./_shared/form-modal-content";
import { useMailRailOwnsTabs } from "../../_lib/mail-section";

interface NotificationsTabProps {
  serverId: string;
  primaryDomain: string;
}

const SCOPES: InboundScope[] = ["mailbox", "domain", "all"];

/** Where notification channels are added and verified — org-wide, not per server. */
const CHANNELS_HREF = "/settings?tab=notifications";

export function NotificationsTab({ serverId, primaryDomain }: NotificationsTabProps) {
  const { showModal, hideModal } = useModal();
  const { t } = useI18n();
  const a = t.emailsAdmin.notifications;
  // Heading lives in the page header in mail view — see ../../_lib/mail-section.
  const hoisted = useMailRailOwnsTabs(serverId);

  const [rules, setRules] = useState<InboundRule[]>([]);
  const [channels, setChannels] = useState<NotificationChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [r, c] = await Promise.all([
        mailAdminApi.inbound.list(serverId),
        notificationsApi
          .listChannels()
          .then((x) => x.channels)
          .catch(() => [] as NotificationChannel[]),
      ]);
      setRules(r.rules);
      setChannels(c);
    } catch (err) {
      setError(getApiErrorMessage(err, a.loadFailed));
    } finally {
      setLoading(false);
    }
  }, [serverId, a.loadFailed]);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Only channels the dispatcher will actually ship to — see the module header. */
  const usable = useMemo(
    () => channels.filter((c) => c.enabled && c.verified && c.kind !== "in_app"),
    [channels],
  );

  const openEditor = (rule?: InboundRule) => {
    const id = showModal({
      // Landscape, not a 600px column. The form has seven fields plus a channel list, and
      // stacked in one column the Save button sat below the fold on a laptop — so the last
      // thing you do was the one thing you had to hunt for.
      maxWidth: "920px",
      showCloseButton: false,
      customContent: (
        <RuleForm
          serverId={serverId}
          rule={rule}
          channels={usable}
          primaryDomain={primaryDomain}
          onCancel={() => hideModal(id)}
          onSaved={() => {
            hideModal(id);
            void reload();
          }}
        />
      ),
    });
  };

  const openDelete = (rule: InboundRule) => {
    const id = showModal({
      maxWidth: "520px",
      showCloseButton: false,
      customContent: (
        <FormModalContent
          title={a.deleteTitle}
          description={interpolate(a.confirmDelete, { name: rule.name })}
          submitLabel={a.deleteConfirm}
          submittingLabel={a.deleting}
          submitVariant="danger"
          onCancel={() => hideModal(id)}
          onSubmit={async () => {
            // Unwrapped, an ApiError surfaces its own "API 409: Conflict" here —
            // which is what the sweep holding this rule looks like, and is not
            // something to show an operator. Same unwrap the rule form does.
            try {
              await mailAdminApi.inbound.remove(serverId, rule.id);
            } catch (err) {
              throw new Error(getApiErrorMessage(err, a.deleteFailed));
            }
            hideModal(id);
            void reload();
          }}
        >
          <p className="text-sm text-muted-foreground">{a.deleteHint}</p>
        </FormModalContent>
      ),
    });
  };

  const runTest = async () => {
    setTesting(true);
    setError(null);
    setNotice(null);
    try {
      const r = await mailAdminApi.inbound.test(serverId);
      setNotice(
        interpolate(a.testResult, {
          read: String(r.read),
          matched: String(r.matched),
          dropped: String(r.dropped),
        }),
      );
    } catch (err) {
      setError(getApiErrorMessage(err, a.testFailed));
    } finally {
      setTesting(false);
    }
  };

  const columns: DataTableColumn<InboundRule>[] = [
    {
      key: "name",
      header: a.colRule,
      width: "minmax(220px, 1.4fr)",
      cell: (r) => (
        <div className="flex items-center gap-3 min-w-0">
          <div className="size-9 rounded-xl bg-muted/50 flex items-center justify-center shrink-0">
            <Bell className="size-4 text-muted-foreground" strokeWidth={2} />
          </div>
          <p className="text-sm font-medium text-foreground truncate">{r.name}</p>
        </div>
      ),
    },
    {
      key: "watch",
      header: a.colWatch,
      width: "minmax(200px, 1.2fr)",
      cell: (r) =>
        r.scope === "all" ? (
          <span className="text-sm text-foreground">{a.scopeAllSummary}</span>
        ) : (
          <span className="text-sm text-foreground font-mono truncate">{r.target ?? "—"}</span>
        ),
    },
    {
      key: "channels",
      header: a.colChannels,
      width: "140px",
      hideBelow: "md",
      cell: (r) => (
        <span className="text-sm text-muted-foreground">
          {interpolate(a.channelCount, { count: String(r.channelIds.length) })}
        </span>
      ),
    },
    {
      key: "status",
      header: a.colStatus,
      width: "150px",
      cell: (r) =>
        r.pausedReason ? (
          <StatusPill tone="warning">
            {a.paused}
          </StatusPill>
        ) : r.enabled ? (
          <StatusPill tone="success">
            {a.active}
          </StatusPill>
        ) : (
          <StatusPill tone="neutral">
            {a.disabled}
          </StatusPill>
        ),
    },
  ];

  return (
    <div className="space-y-5">
      <div
        className={`flex items-center gap-3 flex-wrap ${hoisted ? "justify-end" : "justify-between"}`}
      >
        {!hoisted && (
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-foreground">{a.heading}</h2>
            <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">{a.description}</p>
          </div>
        )}
        <div className="flex items-center gap-2 shrink-0">
          {/* Only once there's something to manage: with no channels the warning
              below carries the same trip as a primary action, and two links to
              one screen read as two different destinations. No Bell here on
              purpose — it labels this section (tab, rows, empty state), so the one
              control that LEAVES the section shouldn't wear it. */}
          {usable.length > 0 && (
            <ChannelsLink
              label={a.manageChannels}
              className="text-muted-foreground hover:text-foreground"
            />
          )}
          <button
            onClick={() => void runTest()}
            disabled={testing || rules.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2.5 border border-border text-foreground text-sm font-medium rounded-xl hover:bg-muted/50 transition-colors disabled:opacity-50"
          >
            <FlaskConical className="size-4" />
            {testing ? a.testing : a.test}
          </button>
          <button
            onClick={() => openEditor()}
            disabled={usable.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-all hover:shadow-lg hover:shadow-primary/25 disabled:opacity-50 disabled:hover:shadow-none"
          >
            <Plus className="size-4" />
            {a.newRule}
          </button>
        </div>
      </div>

      {/* Tone tokens, matching the Domains/Mailboxes/Aliases tabs this one was
          cloned from — `bg-warning/10` is a 10% tint of the FOREGROUND colour,
          which goes muddy grey on the light theme. */}
      {usable.length === 0 && !loading && (
        <div className="rounded-xl border border-warning-border bg-warning-bg px-4 py-3 space-y-2">
          <p className="text-sm text-warning">{a.noChannels}</p>
          <ChannelsLink label={a.addChannel} className="text-warning" />
        </div>
      )}
      {error && (
        <div className="rounded-xl border border-danger-border bg-danger-bg px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}
      {notice && <p className="text-sm text-muted-foreground bg-muted/40 rounded-xl px-4 py-3">{notice}</p>}

      <DataTable
        columns={columns}
        rows={rules}
        rowKey={(r) => r.id}
        loading={loading}
        empty={{
          icon: Bell,
          title: a.emptyTitle,
          description: a.emptyBody,
          // One CTA per screen state. With no channels the warning strip above is
          // already the trip to Settings, and repeating it here as a filled button
          // read as a second, different destination — so the empty card offers the
          // next step only when there IS one it owns.
          action:
            usable.length === 0 ? undefined : (
              <button
                onClick={() => openEditor()}
                className="inline-flex items-center gap-2 px-4 py-2.5 bg-primary text-primary-foreground text-sm font-medium rounded-xl hover:bg-primary/90 transition-colors"
              >
                <Plus className="size-4" />
                {a.newRule}
              </button>
            ),
        }}
        rowActions={(r) => (
          <RowActionsMenu
            label={interpolate(t.emailsAdmin.shared.rowActions, { name: r.name })}
            actions={[
              {
                id: "edit",
                label: a.edit,
                icon: <Pencil className="size-4" />,
                onClick: () => openEditor(r),
              },
              { id: "sep", divider: true },
              {
                id: "delete",
                label: a.deleteConfirm,
                icon: <Trash2 className="size-4" />,
                variant: "danger",
                onClick: () => openDelete(r),
              },
            ]}
          />
        )}
      />
    </div>
  );
}

/**
 * The trip to Settings → Notifications.
 *
 * One component for every place that dead-ends on a missing channel, so they all
 * land on the same screen and none of them describes the route in prose instead of
 * linking it. The arrow flips under RTL — it points at the destination, not right.
 *
 * Underlined at rest, not on hover: inside the warning strip this link is the same
 * amber as the sentence above it, so colour alone would be the only thing marking
 * it clickable — and colour alone is exactly what a low-vision operator can't use.
 *
 * `onNavigate` exists for the instance inside the rule modal. ModalProvider sits in
 * the root layout, above the router outlet, and clears nothing on navigation — so
 * without it the modal stays on screen on top of the Settings page it just sent the
 * operator to.
 */
function ChannelsLink({
  label,
  className,
  onNavigate,
}: {
  label: string;
  className?: string;
  onNavigate?: () => void;
}) {
  return (
    <Link
      href={CHANNELS_HREF}
      onClick={onNavigate}
      className={`inline-flex items-center gap-1.5 text-sm font-medium underline underline-offset-2 decoration-current/40 hover:decoration-current ${className ?? "text-primary"}`}
    >
      {label}
      <ArrowRight className="size-3.5 rtl:rotate-180" />
    </Link>
  );
}

function RuleForm({
  serverId,
  rule,
  channels,
  primaryDomain,
  onCancel,
  onSaved,
}: {
  serverId: string;
  rule?: InboundRule;
  channels: NotificationChannel[];
  primaryDomain: string;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const a = t.emailsAdmin.notifications;

  const [name, setName] = useState(rule?.name ?? "");
  const [scope, setScope] = useState<InboundScope>(rule?.scope ?? "mailbox");
  const [target, setTarget] = useState(rule?.target ?? "");
  const [fromPattern, setFromPattern] = useState(rule?.fromPattern ?? "");
  const [subjectPattern, setSubjectPattern] = useState(rule?.subjectPattern ?? "");
  const [selected, setSelected] = useState<string[]>(rule?.channelIds ?? []);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);

  const needsTarget = scope !== "all";
  const invalid =
    name.trim().length === 0 || selected.length === 0 || (needsTarget && target.trim().length === 0);

  const scopeLabel = (s: InboundScope) =>
    s === "mailbox" ? a.scopeMailbox : s === "domain" ? a.scopeDomain : a.scopeAll;

  return (
    <FormModalContent
      title={rule ? a.editTitle : a.newTitle}
      submitLabel={a.save}
      submittingLabel={a.saving}
      onCancel={onCancel}
      disabled={invalid}
      onSubmit={async () => {
        const payload = {
          name: name.trim(),
          scope,
          target: needsTarget ? target.trim() : null,
          fromPattern: fromPattern.trim() || null,
          subjectPattern: subjectPattern.trim() || null,
          channelIds: selected,
          enabled,
        };
        // FormModalContent surfaces a thrown error, and getApiErrorMessage is what
        // unwraps the server's real message — an ApiError's own `.message` is the
        // useless "API 409: Conflict", which is exactly the foreign-BCC refusal the
        // operator has to read to know what to do.
        try {
          if (rule) await mailAdminApi.inbound.update(serverId, rule.id, payload);
          else await mailAdminApi.inbound.create(serverId, payload);
        } catch (err) {
          throw new Error(getApiErrorMessage(err, a.saveFailed));
        }
        onSaved();
      }}
    >
      {/* Two columns on anything wider than a phone: WHAT to watch on the left, WHERE it goes
          on the right. Grouped by question rather than split down the middle, so neither
          column is a continuation of the other and the eye does not have to zig-zag. */}
      <div className="grid grid-cols-1 gap-x-6 gap-y-5 md:grid-cols-2">
      <div className="space-y-5">
      <Field label={a.fieldName}>
        <input
          className={inputClassName}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={a.namePlaceholder}
        />
      </Field>

      <Field label={a.fieldScope}>
        <CustomSelect
          value={scope}
          options={SCOPES.map((s) => ({ value: s, label: scopeLabel(s) }))}
          onChange={(v) => setScope(v as InboundScope)}
        />
      </Field>

      {needsTarget && (
        <Field
          label={scope === "mailbox" ? a.fieldAddress : a.fieldDomain}
          hint={scope === "mailbox" ? a.mailboxCaveat : undefined}
        >
          <input
            className={inputClassName}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            placeholder={scope === "mailbox" ? `support@${primaryDomain}` : primaryDomain}
          />
        </Field>
      )}

      <Field label={a.fieldFrom}>
        <input
          className={inputClassName}
          value={fromPattern}
          onChange={(e) => setFromPattern(e.target.value)}
          placeholder={a.patternPlaceholder}
        />
      </Field>

      <Field label={a.fieldSubject} hint={a.patternHint}>
        <input
          className={inputClassName}
          value={subjectPattern}
          onChange={(e) => setSubjectPattern(e.target.value)}
          placeholder={a.patternPlaceholder}
        />
      </Field>
      </div>

      <div className="space-y-5">
      <Field label={a.fieldChannels}>
        <div className="space-y-2">
          {/* The same rows the jobs form uses for picking channels — one component, so a
              channel list cannot look like two different products depending on the screen
              it is on. A native checkbox renders in the BROWSER's colours, which is why the
              old list read as pasted in from somewhere else on a dark theme. */}
          <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {channels.map((c) => (
              <Choice
                key={c.id}
                checked={selected.includes(c.id)}
                onToggle={() =>
                  setSelected((prev) =>
                    prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id],
                  )
                }
                label={c.label}
                // The brand mark, not the kind spelled out in parentheses — "discord
                // (discord)" said the same word twice and still made you read to know what
                // it was. Same component the notification settings list uses.
                icon={<ChannelLogo kind={c.kind} className="size-4" />}
              />
            ))}
          </div>
          {/* The channel this rule wants may not exist yet, and the form is modal —
              without this the operator has to cancel to go looking for the screen.
              Closing the modal is part of the trip: nothing else dismisses it, so it
              would otherwise sit on top of the page it just navigated to. */}
          <ChannelsLink label={a.manageChannels} onNavigate={onCancel} />
        </div>
      </Field>

      {/* A button wrapping a presentational Checkbox, not a native input: same reason as the
          channel rows, and it makes the label part of the hit target. */}
      <button
        type="button"
        onClick={() => setEnabled(!enabled)}
        aria-pressed={enabled}
        className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
      >
        <Checkbox checked={enabled} size="sm" className="pointer-events-none" />
        <span>{a.fieldEnabled}</span>
      </button>
      </div>
      </div>
    </FormModalContent>
  );
}
