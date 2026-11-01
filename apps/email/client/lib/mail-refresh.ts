import {
  focusManager,
  onlineManager,
  isCancelledError,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { createStore } from "jotai";
import { optimisticActionsAtom } from "../store/optimistic-updates";
import { backgroundQueueAtom } from "../store/backgroundQueue";
import { getBackendUrl } from "./backend-url";

/** One subscription per mail layout, shared by every list/row query observer. */
export function startMailRefresh(
  queryClient: QueryClient,
  store: ReturnType<typeof createStore>,
  queryKey: QueryKey,
  folder = "inbox",
) {
  const lists = { queryKey, type: "active" } as const;
  let refreshing = false;
  let stopped = false;
  let pending = false;
  let retryBlocked = false;
  let source: EventSource | undefined;

  const hasPendingActions = () =>
    Object.keys(store.get(optimisticActionsAtom)).length > 0 ||
    store.get(backgroundQueueAtom).length > 0 ||
    queryClient.isMutating() > 0;

  const drain = () => {
    if (
      stopped ||
      !pending ||
      retryBlocked ||
      refreshing ||
      !focusManager.isFocused() ||
      !onlineManager.isOnline() ||
      hasPendingActions() ||
      queryClient.isFetching(lists) > 0
    ) {
      return;
    }

    pending = false;
    refreshing = true;
    // Keep every loaded page and its current folder/search/label inputs. Do
    // not interrupt pagination or refetch inactive folders and message bodies.
    void queryClient.refetchQueries(lists, { cancelRefetch: false, throwOnError: true })
      .catch((error: unknown) => {
        pending = true;
        // Retry on a fresh notification or safety poll, never on the failed
        // query's own cache notifications (which would create a busy loop).
        retryBlocked = !isCancelledError(error);
      })
      .finally(() => {
        refreshing = false;
        drain();
      });
  };

  const refresh = () => {
    pending = true;
    retryBlocked = false;
    drain();
  };

  const synchronizeStream = () => {
    if (stopped || !focusManager.isFocused() || !onlineManager.isOnline()) {
      source?.close();
      source = undefined;
      return;
    }
    if (typeof EventSource === "undefined" || (source && source.readyState !== 2)) return;
    const current = new EventSource(
      `${getBackendUrl()}/mail/idle?view=${encodeURIComponent(folder)}`,
      { withCredentials: true },
    );
    source = current;
    // The server sends this once IDLE is ready, including after reconnects.
    // Native EventSource handles transient disconnects without another timer.
    current.addEventListener("mailbox", () => {
      if (source === current) refresh();
    });
  };

  const cancelDuringAction = () => {
    if (refreshing && hasPendingActions()) {
      pending = true;
      // An action may start AFTER a poll. Discard that older response without
      // reverting cache patches, including a polled folder just navigated away from.
      void queryClient.cancelQueries({ queryKey });
    }
    drain();
  };

  const unsubscribe = [
    store.sub(optimisticActionsAtom, cancelDuringAction),
    store.sub(backgroundQueueAtom, cancelDuringAction),
    queryClient.getMutationCache().subscribe(cancelDuringAction),
    queryClient.getQueryCache().subscribe(() => drain()),
    focusManager.subscribe((focused) => {
      synchronizeStream();
      if (focused) refresh();
    }),
    onlineManager.subscribe((online) => {
      synchronizeStream();
      if (online) refresh();
    }),
  ];
  synchronizeStream();
  const timer = setInterval(() => {
    synchronizeStream();
    refresh();
  }, 30_000);

  return () => {
    stopped = true;
    synchronizeStream();
    clearInterval(timer);
    unsubscribe.forEach((stop) => stop());
    if (refreshing) void queryClient.cancelQueries({ queryKey });
  };
}
