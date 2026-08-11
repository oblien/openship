"use client";

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

import { useState } from "react";
import { Boxes, Database, Github, HardDrive, Mail } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ResourceType } from "@/lib/api";

const FALLBACK_ICON: Partial<Record<ResourceType, LucideIcon>> = {
  project: Boxes,
  github_installation: Github,
  github_repository: Github,
  server: HardDrive,
  mail_server: Mail,
  backup_destination: Database,
};

/** GitHub avatar for an account login, or the owner of an "owner/repo" id. */
function githubAvatar(resourceType: ResourceType, resourceId: string, size: number): string | null {
  if (resourceId === "*") return null;
  if (resourceType === "github_installation") {
    return `https://github.com/${encodeURIComponent(resourceId)}.png?size=${size}`;
  }
  if (resourceType === "github_repository") {
    const owner = resourceId.split("/")[0];
    return owner ? `https://github.com/${encodeURIComponent(owner)}.png?size=${size}` : null;
  }
  return null;
}

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
  const src = failed ? null : githubAvatar(resourceType, resourceId, pixels);

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

  const Icon = FALLBACK_ICON[resourceType] ?? Boxes;
  return (
    <span
      aria-hidden
      className={`${className} flex shrink-0 items-center justify-center rounded-full bg-muted/60 text-muted-foreground`}
    >
      <Icon className="size-3" strokeWidth={1.8} />
    </span>
  );
}
