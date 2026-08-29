"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { systemApi } from "@/lib/api";
import { issuesApi, type SystemIssue } from "@/lib/api/issues";
import { useIssueActions } from "@/components/issues/useIssueActions";
import { infraScanStale, markInfraScanned } from "@/lib/infra-autoscan";
import { hide as hideCard, isHidden, type AttentionCardKey } from "@/lib/attention-hide";

/**
 * The home page's read of `/issues`, split into what is broken and what is merely
 * behind — one card each, at most two.
 *
 * It sits outside the cards because the home column makes TWO decisions from this one
 * feed: which attention cards to render, and whether the Activity overview above them
 * still earns its space. While the card owned the fetch, the page could only learn the
 * count by asking again or by taking a callback from its own child.
 *
 * Severity is the server's — this only decides which of the two cards a row belongs to,
 * and an advisory is never allowed into the alarm card. Hiding a card is browser-local
 * and self-expiring; see {@link isHidden} for why it can't bury a new problem.
 */
export function useAttentionFeed() {
  const [issues, setIssues] = useState<SystemIssue[] | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await issuesApi.list();
      setIssues(res?.data ?? []);
    } catch {
      setIssues([]); // fail-soft → the column falls back to the product tip
    }
  }, []);

  const { busyId, resolve, infraFix } = useIssueActions(load);

  const autoScanRan = useRef(false);
  useEffect(() => {
    // When auto-scan is on and the shared cache is stale, run ONE detect-only scan
    // first so the feed reflects live drift, then read it. Otherwise read straight
    // from the cache the scheduled jobs maintain. The localStorage throttle plus this
    // ref keep it to one probe per window, shared with the Infrastructure tab, even
    // under StrictMode's double-mount.
    void (async () => {
      const on = await systemApi.getInfraAutoScan().catch(() => false);
      if (on && !autoScanRan.current && infraScanStale()) {
        autoScanRan.current = true;
        markInfraScanned();
        await systemApi.scanAllContainers().catch(() => {});
      }
      void load();
    })();
  }, [load]);

  const { broken, behind } = useMemo(() => {
    const rows = issues ?? [];
    return {
      broken: rows.filter((i) => i.severity !== "advisory"),
      behind: rows.filter((i) => i.severity === "advisory"),
    };
  }, [issues]);

  // Which cards the operator has hidden, re-derived from storage every time the feed
  // changes rather than remembered here: a hide is only valid for the exact set it was
  // taken on, so a refetch that brings a new issue in must un-hide the card. Storage is
  // read in an effect, never during render, so the server and the first client paint
  // agree (neither renders a card while `issues` is still null).
  const [hidden, setHidden] = useState<AttentionCardKey[]>([]);
  useEffect(() => {
    const next: AttentionCardKey[] = [];
    if (isHidden("broken", broken.map((i) => i.id))) next.push("broken");
    if (isHidden("behind", behind.map((i) => i.id))) next.push("behind");
    setHidden(next);
  }, [broken, behind]);

  const hide = useCallback(
    (card: AttentionCardKey) => {
      hideCard(card, (card === "broken" ? broken : behind).map((i) => i.id));
      setHidden((prev) => (prev.includes(card) ? prev : [...prev, card]));
    },
    [broken, behind],
  );

  const showBroken = broken.length > 0 && !hidden.includes("broken");
  const showBehind = behind.length > 0 && !hidden.includes("behind");

  return {
    broken,
    behind,
    /** False until `/issues` has answered — a caller that states a status needs to
     *  know the difference between "nothing is wrong" and "nothing read yet". */
    loaded: issues !== null,
    showBroken,
    showBehind,
    /**
     * 0, 1 or 2 — how many cards the attention slot will actually render, hides
     * included. The home column spends this as a budget, dropping its least urgent
     * card per alert panel (Activity at 1, Apps at 2). Counting hidden panels as
     * absent is deliberate: hiding one hands that space straight back, which is the
     * trade the operator made by hiding it.
     */
    cards: (showBroken ? 1 : 0) + (showBehind ? 1 : 0),
    hide,
    busyId,
    resolve,
    infraFix,
  };
}

export type AttentionFeed = ReturnType<typeof useAttentionFeed>;
