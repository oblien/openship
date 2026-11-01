"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Icon as UiIcon } from "@repo/ui/icons";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { CustomSelect } from "@/components/ui/CustomSelect";
import { ChannelLogo } from "@/components/ui/ChannelLogo";
import { useI18n } from "@/components/i18n-provider";
import { useToast } from "@/context/ToastContext";
import { systemApi } from "@/lib/api/system";
import { getApiErrorMessage } from "@/lib/api/client";
import {
  notificationsApi,
  type NotificationChannel,
  type ChannelKind,
} from "@/lib/api/notifications";

const DEFAULT_KIND_CHOICES: ChannelKind[] = [
  "email",
  "webhook",
  "slack",
  "discord",
  "msteams",
  "telegram",
];

/** Shared by Settings and inline workflow setup; credentials never leave this form. */
export function NotificationChannelForm({
  channel,
  onSaved,
  onCancel,
  onBusyChange,
  onCreated,
}: {
  channel?: NotificationChannel;
  onSaved: (channel: NotificationChannel) => void | Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  onCreated?: (channel: NotificationChannel) => void;
  onCancel: () => void;
}) {
  const { showToast } = useToast();
  const { t } = useI18n();
  const [kind, setKind] = useState<ChannelKind>(channel?.kind ?? "email");
  const [label, setLabel] = useState(channel?.label ?? "");
  const [address, setAddress] = useState(String(channel?.config.address ?? ""));
  const [url, setUrl] = useState(String(channel?.config.url ?? ""));
  const [webhookUrl, setWebhookUrl] = useState("");
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState(String(channel?.config.chatId ?? ""));
  const [signingSecret, setSigningSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const inFlight = useRef(false);
  const saved = useRef<NotificationChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  // Whether the instance can send email at all (instance SMTP / mail server /
  // env). null = unknown (not yet loaded, or no permission to read). When false
  // we nudge the operator to configure SMTP — email channels won't deliver.
  const [emailDeliverable, setEmailDeliverable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    systemApi
      .getEmailSettings()
      .then((r) => {
        if (!cancelled) setEmailDeliverable(!!r.deliverable);
      })
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/notifications/channel-form");
        if (!cancelled) setEmailDeliverable(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async () => {
    if (inFlight.current) return;
    if (!label.trim()) {
      showToast(
        t.settings.notifications.form.labelRequired,
        "error",
        t.settings.common.toast.notifications,
      );
      return;
    }
    let config: Record<string, unknown> = {};
    if (kind === "email") config = { address: address.trim() };
    else if (kind === "webhook") config = { url: url.trim() };
    else if (kind === "slack" || kind === "discord" || kind === "msteams")
      config = { webhookUrl: webhookUrl.trim() };
    else if (kind === "telegram") config = { botToken: botToken.trim(), chatId: chatId.trim() };

    inFlight.current = true;
    setError(null);
    setBusy(true);
    try {
      // Never round-trip the redacted config object. Whitelist editable fields,
      // omit blank secrets, and only send config when the destination changed.
      let changedConfig: Record<string, unknown> | undefined;
      if (channel) {
        if (kind === "email" && address.trim() !== channel.config.address)
          changedConfig = { address: address.trim() };
        else if (kind === "webhook" && url.trim() !== channel.config.url)
          changedConfig = { url: url.trim() };
        else if (["slack", "discord", "msteams"].includes(kind) && webhookUrl.trim()) {
          changedConfig = { webhookUrl: webhookUrl.trim() };
          if (kind === "slack" && typeof channel.config.channelName === "string")
            changedConfig.channelName = channel.config.channelName;
        } else if (
          kind === "telegram" &&
          (botToken.trim() || chatId.trim() !== channel.config.chatId)
        ) {
          changedConfig = { chatId: chatId.trim() };
          if (botToken.trim()) changedConfig.botToken = botToken.trim();
          if (channel.config.messageThreadId != null)
            changedConfig.messageThreadId = channel.config.messageThreadId;
        }
      }
      const result = channel
        ? await notificationsApi.updateChannel(channel.id, {
            label: label.trim(),
            ...(changedConfig ? { config: changedConfig } : {}),
          })
        : await notificationsApi.createChannel({ kind, label: label.trim(), config });
      if (!active.current) return;
      saved.current = result.channel;
      onCreated?.(result.channel);
      showToast(
        channel
          ? t.settings.notifications.channels.updated
          : t.settings.notifications.channels.channelAdded,
        "success",
        t.settings.common.toast.notifications,
      );
      if (result?.secret) setSigningSecret(result.secret);
      else await onSaved(result.channel);
    } catch (err) {
      if (active.current) setError(getApiErrorMessage(err));
    } finally {
      inFlight.current = false;
      if (active.current) setBusy(false);
    }
  };

  if (signingSecret)
    return (
      <div className="rounded-xl bg-card p-4 space-y-4">
        <label className="block space-y-2 text-sm text-foreground">
          <span>{t.settings.notifications.form.signingSecret}</span>
          <Input
            variant="filled"
            readOnly
            dir="ltr"
            value={signingSecret}
            onFocus={(event) => event.target.select()}
          />
        </label>
        <p className="text-sm text-muted-foreground">{t.settings.notifications.form.secretHint}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="secondary"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(signingSecret);
                if (active.current) setCopied(true);
              } catch {
                // diagnostics-ignore: Clipboard may be unavailable on HTTP; the read-only field supports manual selection.
              }
            }}
          >
            {copied ? t.settings.common.copied : t.settings.common.copy}
          </Button>
          <Button
            type="button"
            onClick={() => {
              setSigningSecret(null);
              if (saved.current) void onSaved(saved.current);
            }}
          >
            {t.settings.common.done}
          </Button>
        </div>
      </div>
    );

  return (
    <div className="rounded-xl bg-card p-4 space-y-4">
      {channel && (
        <p className="text-sm text-muted-foreground">{t.settings.notifications.form.editHint}</p>
      )}
      <label className="block space-y-2 text-sm text-foreground">
        <span>{t.settings.notifications.form.channelType}</span>
        <CustomSelect
          variant="filled"
          triggerClassName="bg-muted/60 hover:bg-muted"
          aria-label={t.settings.notifications.form.channelType}
          options={(channel?.kind === "in_app" ? ["in_app" as const] : DEFAULT_KIND_CHOICES).map(
            (k) => ({
              value: k,
              label: t.settings.notifications.kinds[k],
              icon: <ChannelLogo kind={k} className="size-4" />,
            }),
          )}
          value={kind}
          onChange={setKind}
          disabled={busy || !!channel}
        />
      </label>
      <label className="block space-y-2 text-sm text-foreground">
        <span>{t.settings.notifications.form.labels.name}</span>
        <Input
          variant="filled"
          disabled={busy}
          type="text"
          placeholder={t.settings.notifications.form.labelPlaceholder}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </label>

      {kind === "email" && (
        <label className="block space-y-2 text-sm text-foreground">
          <span>{t.settings.notifications.form.labels.address}</span>
          <Input
            variant="filled"
            disabled={busy}
            type="email"
            placeholder={t.settings.notifications.form.emailPlaceholder}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </label>
      )}
      {kind === "email" && emailDeliverable === false && (
        <div className="flex items-start gap-2 rounded-lg bg-warning-bg px-3 py-2 text-xs text-warning">
          <UiIcon name="warning" className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {t.settings.notifications.form.noEmailTransport}{" "}
            <Link
              href="/settings?tab=email"
              className="font-medium underline underline-offset-2 hover:opacity-80"
            >
              {t.settings.notifications.form.setUpSmtp}
            </Link>
          </span>
        </div>
      )}
      {kind === "webhook" && (
        <label className="block space-y-2 text-sm text-foreground">
          <span>{t.settings.notifications.form.labels.url}</span>
          <Input
            variant="filled"
            disabled={busy}
            type="url"
            placeholder={t.settings.notifications.form.webhookPlaceholder}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
        </label>
      )}
      {kind === "slack" && (
        <label className="block space-y-2 text-sm text-foreground">
          <span>{t.settings.notifications.form.labels.url}</span>
          <Input
            variant="filled"
            disabled={busy}
            type="url"
            placeholder={t.settings.notifications.form.slackPlaceholder}
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
        </label>
      )}
      {kind === "discord" && (
        <label className="block space-y-2 text-sm text-foreground">
          <span>{t.settings.notifications.form.labels.url}</span>
          <Input
            variant="filled"
            disabled={busy}
            type="url"
            placeholder={t.settings.notifications.form.discordPlaceholder}
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
        </label>
      )}
      {kind === "msteams" && (
        <label className="block space-y-2 text-sm text-foreground">
          <span>{t.settings.notifications.form.labels.url}</span>
          <Input
            variant="filled"
            disabled={busy}
            type="url"
            placeholder={t.settings.notifications.form.msteamsPlaceholder}
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
          />
        </label>
      )}
      {/* The only kind needing two inputs: a bot identity plus a destination. */}
      {kind === "telegram" && (
        <>
          <label className="block space-y-2 text-sm text-foreground">
            <span>{t.settings.notifications.form.labels.botToken}</span>
            <Input
              variant="filled"
              disabled={busy}
              type="password"
              autoComplete="off"
              placeholder={t.settings.notifications.form.telegramTokenPlaceholder}
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
            />
          </label>
          <label className="block space-y-2 text-sm text-foreground">
            <span>{t.settings.notifications.form.labels.chatId}</span>
            <Input
              variant="filled"
              disabled={busy}
              type="text"
              placeholder={t.settings.notifications.form.telegramChatPlaceholder}
              value={chatId}
              onChange={(e) => setChatId(e.target.value)}
            />
          </label>
          <p className="text-xs text-muted-foreground">
            {t.settings.notifications.form.telegramHint}
          </p>
        </>
      )}

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button type="button" onClick={submit} disabled={busy}>
          {busy
            ? t.settings.notifications.form.saving
            : channel
              ? t.settings.common.save
              : t.settings.notifications.form.addChannel}
        </Button>
        <Button type="button" onClick={onCancel} variant="ghost" disabled={busy}>
          {t.settings.common.cancel}
        </Button>
      </div>
    </div>
  );
}
