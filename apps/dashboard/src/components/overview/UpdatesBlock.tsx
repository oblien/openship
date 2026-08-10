"use client";

import type { AttentionFeed } from "@/hooks/useAttentionFeed";
import { IssuesCard, UpdatesCard } from "./AttentionCards";
import HomeTipCard from "./HomeTipCard";

interface UpdatesBlockProps {
  /** The already-read feed, from {@link useAttentionFeed} on the home page. */
  feed: AttentionFeed;
  projectCount: number;
  loading: boolean;
}

/**
 * Home attention slot — the alert-driven replacement for the static quick-tip in the
 * right column. What's broken ranks above what's merely behind; with neither, the slot
 * falls back to the product tip rather than going empty.
 *
 * The rows come from `/issues` — the same feed the tracker page serves — read once by
 * the home page and passed in, because the page also needs the card count to decide
 * whether the Activity overview above still fits. This used to call
 * `/containers/issues` + `/containers/behind` and judge severity itself, which meant
 * the slot could only ever see edge and mail: a crash-looping container that had
 * already paged Telegram was invisible on the panel titled "Needs attention". One
 * read, one definition, and every source the feed grows reaches the home page free.
 */
export default function UpdatesBlock({ feed, projectCount, loading }: UpdatesBlockProps) {
  const { broken, behind, busyId, resolve, infraFix, hide } = feed;

  // Nothing wrong and nothing to update → the product tip (also the still-loading
  // state, where the feed is empty for a beat, and the state where both cards have
  // been hidden — the slot shows the tip rather than a gap).
  if (feed.cards === 0) {
    return <HomeTipCard projectCount={projectCount} loading={loading} />;
  }

  return (
    <div className="space-y-3">
      {feed.showBroken && (
        <IssuesCard
          issues={broken}
          busyId={busyId}
          onResolve={resolve}
          onInfraFix={infraFix}
          onHide={() => hide("broken")}
        />
      )}
      {feed.showBehind && (
        <UpdatesCard
          issues={behind}
          busyId={busyId}
          onResolve={resolve}
          onInfraFix={infraFix}
          onHide={() => hide("behind")}
        />
      )}
    </div>
  );
}
