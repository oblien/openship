"use client";

import type { AttentionFeed } from "@/hooks/useAttentionFeed";
import { IssuesCard, UpdatesCard } from "./AttentionCards";

interface UpdatesBlockProps {
  /** The already-read feed, from {@link useAttentionFeed} on the home page. */
  feed: AttentionFeed;
}

/**
 * Home attention slot. What's broken ranks above what's merely behind.
 * The page places optional content after these actionable cards.
 *
 * The rows come from `/issues` — the same feed the tracker page serves — read once by
 * the home page and passed in, because the page also needs the card count to decide
 * whether the Activity overview above still fits. This used to call
 * `/containers/issues` + `/containers/behind` and judge severity itself, which meant
 * the slot could only ever see edge and mail: a crash-looping container that had
 * already paged Telegram was invisible on the panel titled "Needs attention". One
 * read, one definition, and every source the feed grows reaches the home page free.
 */
export default function UpdatesBlock({ feed }: UpdatesBlockProps) {
  const { broken, behind, busyIds, resolve, infraFix, hide } = feed;

  if (feed.cards === 0) return null;

  return (
    <div className="space-y-3">
      {feed.showBroken && (
        <IssuesCard
          issues={broken}
          busyIds={busyIds}
          onResolve={resolve}
          onInfraFix={infraFix}
          onHide={() => hide("broken")}
        />
      )}
      {feed.showBehind && (
        <UpdatesCard
          issues={behind}
          busyIds={busyIds}
          onResolve={resolve}
          onInfraFix={infraFix}
          onHide={() => hide("behind")}
        />
      )}
    </div>
  );
}
