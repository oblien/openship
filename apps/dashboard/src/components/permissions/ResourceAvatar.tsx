"use client";

import { Icon as UiIcon, type IconName } from "@repo/ui/icons";

/**
 * Small identity glyph for a granted resource.
 *
 * GitHub accounts and repos get their real avatar via github.com's `<login>.png`
 * redirect — the same trick the local-service catalog already uses — because a
 * consent screen listing five org names is far easier to scan when the orgs look
 * like themselves. Everything else falls back to a type icon.
 *
 * Fails soft: a broken or blocked image swaps to the fallback icon rather than
 * leaving a torn img, so this works offline and behind egress restrictions.
 */

import { gitGrantTarget, gitProviderForGrant, type RegisteredGitProvider, type GitProviderDefinition } from "@repo/core";
import { useState } from "react";
import type { ResourceType } from "@/lib/api";

// Every grantable type needs an entry or it renders as a generic box, which makes
// a 14-tab picker unreadable. Keyed by the full ResourceType so adding a grantable
// type without an icon is visible here rather than in the UI.
const FALLBACK_ICON: Record<Exclude<ResourceType, RegisteredGitProvider["grantTypes"]["namespace" | "repository"]>, IconName> = {
  project: "project",
  server: "hard-drive",
  mail_server: "mail",
  backup_destination: "database",
  job: "timer",
  notifications: "bell",
  analytics: "activity",
  settings: "settings",
  updates: "arrow-up-circle",
  cloud: "cloud",
  audit: "file-text",
  billing: "credit-card",
};

export function ResourceAvatar({
  resourceType,
  resourceId,
  className = "size-5",
  pixels = 40,
}: {
  resourceType: ResourceType;
  resourceId: string;
  /** Tailwind size classes for the rendered glyph. */
  className?: string;
  /** Requested avatar pixel size — pass 2× the rendered size for retina. */
  pixels?: number;
}) {
  const [failed, setFailed] = useState(false);
  const provider = gitProviderForGrant(resourceType);
  const avatar = (provider as GitProviderDefinition | undefined)?.avatarUrl;
  const src = provider && avatar && resourceId !== "*" && !failed
    ? avatar(gitGrantTarget(provider, resourceType, resourceId).owner, pixels) : null;

  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- remote avatar, no loader configured
      <img
        src={src}
        alt=""
        aria-hidden
        onError={() => setFailed(true)}
        className={`${className} shrink-0 rounded-full bg-muted object-cover`}
      />
    );
  }

  const Icon = provider?.icon ?? FALLBACK_ICON[resourceType as keyof typeof FALLBACK_ICON] ?? "help-circle";
  return (
    <span
      aria-hidden
      className={`${className} flex shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground`}
    >
      <UiIcon name={Icon} className="size-3" />
    </span>
  );
}
