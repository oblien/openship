"use client";

import {
  Mail,
  MessageCircle,
  MessagesSquare,
  MessageSquare,
  Send,
  Smartphone,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import type { ChannelKind } from "@/lib/api/notifications";
import { AppLogo } from "@/components/AppLogo";

/**
 * The mark for a notification channel — Slack, Discord, Telegram and Teams as their real
 * brand logos, a lucide glyph for the kinds that have none (email, webhook, in-app).
 *
 * Extracted from `NotificationsTab`, where it lived as a local helper. Anything that lists
 * channels needs it — the settings screen, the mail server's notification rules — and a
 * second copy is how one list ends up showing brand marks while another shows the kind in
 * parentheses.
 */

/** Lucide glyph per kind. Exported because `PillSwitcher` takes the slug and the fallback
 *  icon as separate props rather than a rendered node. */
export const CHANNEL_ICONS: Record<ChannelKind, LucideIcon> = {
  email: Mail,
  webhook: Webhook,
  slack: MessageSquare,
  discord: MessageCircle,
  msteams: MessagesSquare,
  telegram: Send,
  in_app: Smartphone,
};

/** simpleicons slug per BRANDED kind — AppLogo fetches and brand-colours it. */
export const CHANNEL_LOGOS: Partial<Record<ChannelKind, string>> = {
  slack: "slack",
  discord: "discord",
  msteams: "microsoftteams",
  telegram: "telegram",
};

/** Display name per kind, so no caller has to capitalise a raw enum value itself. */
export const CHANNEL_LABELS: Record<ChannelKind, string> = {
  email: "Email",
  webhook: "Webhook",
  slack: "Slack",
  discord: "Discord",
  msteams: "Microsoft Teams",
  telegram: "Telegram",
  in_app: "In-app",
};

export function ChannelLogo({
  kind,
  className = "size-4",
}: {
  kind: ChannelKind;
  className?: string;
}) {
  const slug = CHANNEL_LOGOS[kind];
  if (slug) return <AppLogo slug={slug} icon={CHANNEL_ICONS[kind]} className={className} />;
  const Icon = CHANNEL_ICONS[kind];
  return <Icon className={`${className} text-foreground`} strokeWidth={1.7} />;
}
