import { addOptimisticActionAtom, removeOptimisticActionAtom } from '@/store/optimistic-updates';
import { optimisticActionsManager, type PendingAction } from '@/lib/optimistic-actions-manager';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { backgroundQueueAtom } from '@/store/backgroundQueue';
import type { ThreadDestination } from '@/lib/thread-actions';
import { useTRPC } from '@/providers/query-provider';
import { useMail } from '@/components/mail/use-mail';
import { moveThreadsTo } from '@/lib/thread-actions';
import { m } from '@/paraglide/messages';
import { useQueryState } from 'nuqs';
import { useCallback } from 'react';
import posthog from 'posthog-js';
import { useAtom } from 'jotai';
import { toast } from 'sonner';

enum ActionType {
  MOVE = 'MOVE',
  STAR = 'STAR',
  READ = 'READ',
  LABEL = 'LABEL',
  IMPORTANT = 'IMPORTANT',
  SNOOZE = 'SNOOZE',
  UNSNOOZE = 'UNSNOOZE',
  DELETE_DRAFT = 'DELETE_DRAFT',
}

// Update the params interface
interface ActionParams {
  starred?: boolean;
  read?: boolean;
  important?: boolean;
  labelId?: string;
  add?: boolean;
  currentFolder?: string;
  destination?: ThreadDestination;
  wakeAt?: string;
}

const actionEventNames: Record<ActionType, (params: ActionParams) => string> = {
  [ActionType.MOVE]: () => 'email_moved',
  [ActionType.STAR]: (params) => (params.starred ? 'email_starred' : 'email_unstarred'),
  [ActionType.READ]: (params) => (params.read ? 'email_marked_read' : 'email_marked_unread'),
  [ActionType.IMPORTANT]: (params) =>
    params.important ? 'email_marked_important' : 'email_unmarked_important',
  [ActionType.LABEL]: (params) => (params.add ? 'email_label_added' : 'email_label_removed'),
  [ActionType.SNOOZE]: () => 'email_snoozed',
  [ActionType.UNSNOOZE]: () => 'email_unsnoozed',
  [ActionType.DELETE_DRAFT]: () => 'draft_deleted',
};

export function useOptimisticActions() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [, setBackgroundQueue] = useAtom(backgroundQueueAtom);
  const [, addOptimisticAction] = useAtom(addOptimisticActionAtom);
  const [, removeOptimisticAction] = useAtom(removeOptimisticActionAtom);
  const [threadId, setThreadId] = useQueryState('threadId');
  const [, setActiveReplyId] = useQueryState('activeReplyId');
  const [mail, setMail] = useMail();
  const { mutateAsync: markAsRead } = useMutation(trpc.mail.markAsRead.mutationOptions());
  const { mutateAsync: markAsUnread } = useMutation(trpc.mail.markAsUnread.mutationOptions());

  const { mutateAsync: toggleStar } = useMutation(trpc.mail.toggleStar.mutationOptions());
  const { mutateAsync: toggleImportant } = useMutation(trpc.mail.toggleImportant.mutationOptions());

  const { mutateAsync: bulkDeleteThread } = useMutation(trpc.mail.bulkDelete.mutationOptions());
  const { mutateAsync: snoozeThreads } = useMutation(trpc.mail.snoozeThreads.mutationOptions());
  const { mutateAsync: unsnoozeThreads } = useMutation(trpc.mail.unsnoozeThreads.mutationOptions());
  const { mutateAsync: modifyLabels } = useMutation(trpc.mail.modifyLabels.mutationOptions());

  const { mutateAsync: deleteDraft } = useMutation(trpc.drafts.delete.mutationOptions());

  const generatePendingActionId = () =>
    `pending_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

  // After an optimistic action's server call succeeds we drop the optimistic
  // overlay - which means the UI reads from the underlying tRPC caches. If
  // those caches still hold the pre-action state (read/unread, star, label,
  // etc.) the change visibly snaps back. Invalidate them so the next render
  // reflects what the server now knows. We avoid `refetchQueries` to keep
  // this cheap when no consumer is mounted; React Query will refetch the
  // active ones automatically.
  //
  // CRITICAL: use `.pathKey()` (prefix only) - NOT `.queryKey()`. tRPC v11's
  // `.queryKey()` appends `{ type: 'query' }`, which fails the element-by-
  // element partial-match against the infinite cache entry (which has
  // `{ input, type: 'infinite' }`). pathKey omits the type marker and
  // matches both shapes.
  const refreshData = useCallback(async () => {
    await Promise.all([
      queryClient.refetchQueries({ queryKey: trpc.labels.list.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.mail.listThreads.pathKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.mail.get.pathKey() }),
    ]);
  }, [queryClient, trpc]);

  function createPendingAction({
    type,
    threadIds,
    params,
    optimisticId,
    execute,
    undo,
    toastMessage,
    skipRefresh,
  }: {
    type: keyof typeof ActionType;
    threadIds: string[];
    params: PendingAction['params'];
    optimisticId: string;
    execute: () => Promise<void>;
    undo: () => void;
    toastMessage: string;
    folders?: string[];
    // When the caller already patched the relevant caches directly, the
    // listThreads/mail.get refetch is not just unnecessary - it actively
    // overwrites the patch if an earlier in-flight fetch (started before
    // the RPC landed) returns first. Mark-as-read sets this true.
    skipRefresh?: boolean;
  }) {
    const pendingActionId = generatePendingActionId();
    optimisticActionsManager.lastActionId = pendingActionId;
    console.log('here Generated pending action ID:', pendingActionId);

    if (!optimisticActionsManager.pendingActionsByType.has(type)) {
      console.log('here Creating new Set for action type:', type);
      optimisticActionsManager.pendingActionsByType.set(type, new Set());
    }
    optimisticActionsManager.pendingActionsByType.get(type)?.add(pendingActionId);
    console.log(
      'here',
      'Added pending action to type:',
      type,
      'Current size:',
      optimisticActionsManager.pendingActionsByType.get(type)?.size,
    );

    const pendingAction = {
      id: pendingActionId,
      type,
      threadIds,
      params,
      optimisticId,
      execute,
      undo,
    };

    optimisticActionsManager.pendingActions.set(pendingActionId, pendingAction as PendingAction);

    const itemCount = threadIds.length;
    const bulkActionMessage = itemCount > 1 ? `${toastMessage} (${itemCount} items)` : toastMessage;

    async function doAction() {
      try {
        await execute();

        const eventName = actionEventNames[type]?.(params);
        if (eventName) {
          posthog.capture(eventName);
        }

        optimisticActionsManager.pendingActions.delete(pendingActionId);
        optimisticActionsManager.pendingActionsByType.get(type)?.delete(pendingActionId);

        // Refresh the cache BEFORE removing the optimistic overlay. If we
        // dropped the overlay first, the UI would re-render from the still-
        // stale tRPC cache and visibly snap back to the pre-action state
        // until invalidateQueries' refetch lands - the "flickers back to
        // unread when I click another thread" bug. React Query dedupes
        // concurrent invalidations of the same key, so a burst of clicks
        // still results in one refetch per active query.
        //
        // Callers that already patched the relevant query caches directly
        // (e.g. mark-as-read via setQueriesData) pass skipRefresh:true to
        // avoid the in-flight-refetch race that overwrites their patch.
        if (!skipRefresh) {
          await refreshData();
        }
        removeOptimisticAction(optimisticId);
      } catch (error) {
        console.error('Action failed:', error);
        removeOptimisticAction(optimisticId);
        optimisticActionsManager.pendingActions.delete(pendingActionId);
        optimisticActionsManager.pendingActionsByType.get(type)?.delete(pendingActionId);
        toast.error('Action failed');
      }
    }

    if (toastMessage.trim().length) {
      toast(bulkActionMessage, {
        onAutoClose: () => {
          doAction();
        },
        onDismiss: () => {
          doAction();
        },
        action: {
          label: 'Undo',
          onClick: () => {
            undo();
            optimisticActionsManager.pendingActions.delete(pendingActionId);
            optimisticActionsManager.pendingActionsByType.get(type)?.delete(pendingActionId);
          },
        },
        duration: 5000,
      });
    } else {
      doAction();
    }

    return pendingActionId;
  }

  // Patch the listThreads infinite-query cache so the row's `hasUnread`
  // matches the new state without waiting on a server refetch. The earlier
  // "invalidate + await" strategy raced badly: if a listThreads refetch
  // was already in flight when our IMAP STORE landed, react-query deduped
  // and our `await` resolved on the *earlier* (stale) fetch. Dropping the
  // overlay then made the row visibly revert to unread.
  //
  // Key choice: `.pathKey()`, not `.queryKey()`. tRPC v11's queryKey()
  // returns `[path, { type: 'query' }]`; the infinite cache entry's key
  // is `[path, { input, type: 'infinite' }]`. React Query's partial match
  // compares the type-marker object element-by-element, so queryKey()
  // never matched the infinite entry and the patch silently no-op'd -
  // the same reason the old invalidateQueries call was a no-op and the
  // row reverted when the overlay was dropped. pathKey is the bare
  // prefix and matches every variant under that procedure.
  const patchListThreadsRead = useCallback(
    (threadIds: string[], read: boolean) => {
      const ids = new Set(threadIds);
      queryClient.setQueriesData<{
        pageParams: unknown[];
        pages: Array<{ threads: Array<Record<string, unknown>>; [k: string]: unknown }>;
      }>(
        { queryKey: trpc.mail.listThreads.pathKey() },
        (old) => {
          if (!old?.pages) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              threads: page.threads?.map((t) =>
                ids.has(t.id as string)
                  ? {
                      ...t,
                      hasUnread: !read,
                      latest: t.latest
                        ? { ...(t.latest as Record<string, unknown>), unread: !read, isUnread: !read }
                        : t.latest,
                    }
                  : t,
              ),
            })),
          };
        },
      );
    },
    [queryClient, trpc],
  );

  // mail.get is keyed by `{ id, folder }`, so a single thread may have
  // entries cached under multiple folders. Match by path and filter the
  // ones whose data id matches inside the updater.
  const patchMailGetRead = useCallback(
    (threadIds: string[], read: boolean) => {
      const ids = new Set(threadIds);
      queryClient.setQueriesData<Record<string, unknown> | null>(
        { queryKey: trpc.mail.get.pathKey() },
        (old) => {
          if (!old) return old;
          const oldId = old.id as string | undefined;
          if (!oldId || !ids.has(oldId)) return old;
          return { ...old, hasUnread: !read };
        },
      );
    },
    [queryClient, trpc],
  );

  // Toggle a per-message tag (STARRED / IMPORTANT) on the listThreads
  // infinite cache. The row reads its star/important state from
  // `latest.tags` - so we add or remove the tag in place. Same pathKey
  // story as the read patch: queryKey() would miss the infinite entry.
  const patchListThreadsTag = useCallback(
    (threadIds: string[], tagName: 'STARRED' | 'IMPORTANT', present: boolean) => {
      const ids = new Set(threadIds);
      queryClient.setQueriesData<{
        pageParams: unknown[];
        pages: Array<{ threads: Array<Record<string, unknown>>; [k: string]: unknown }>;
      }>(
        { queryKey: trpc.mail.listThreads.pathKey() },
        (old) => {
          if (!old?.pages) return old;
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              threads: page.threads?.map((t) => {
                if (!ids.has(t.id as string)) return t;
                const latest = t.latest as Record<string, unknown> | undefined;
                if (!latest) return t;
                const tags = ((latest.tags as Array<{ id?: string; name: string }>) ?? []).filter(
                  Boolean,
                );
                const has = tags.some((tag) => tag?.name === tagName);
                let newTags = tags;
                if (present && !has) {
                  newTags = [...tags, { id: `${tagName.toLowerCase()}-optimistic`, name: tagName }];
                } else if (!present && has) {
                  newTags = tags.filter((tag) => tag?.name !== tagName);
                }
                return { ...t, latest: { ...latest, tags: newTags } };
              }),
            })),
          };
        },
      );
    },
    [queryClient, trpc],
  );

  const optimisticMarkAsRead = useCallback(
    (threadIds: string[], silent = false) => {
      if (!threadIds.length) return;

      const optimisticId = addOptimisticAction({
        type: 'READ',
        threadIds,
        read: true,
      });

      // Patch the cache before the RPC so the post-overlay state is already
      // correct in the query data - we no longer depend on a refetch to
      // sync, sidestepping the stale-in-flight-refetch race.
      patchListThreadsRead(threadIds, true);
      patchMailGetRead(threadIds, true);

      createPendingAction({
        type: 'READ',
        threadIds,
        params: { read: true },
        optimisticId,
        execute: async () => {
          await markAsRead({ ids: threadIds });

          if (mail.bulkSelected.length > 0) {
            setMail((prev) => ({ ...prev, bulkSelected: [] }));
          }
        },
        undo: () => {
          patchListThreadsRead(threadIds, false);
          patchMailGetRead(threadIds, false);
          removeOptimisticAction(optimisticId);
        },
        toastMessage: silent ? '' : 'Marked as read',
        skipRefresh: true,
      });
    },
    [
      queryClient,
      trpc,
      addOptimisticAction,
      removeOptimisticAction,
      markAsRead,
      setMail,
      patchListThreadsRead,
      patchMailGetRead,
    ],
  );

  function optimisticMarkAsUnread(threadIds: string[]) {
    if (!threadIds.length) return;

    const optimisticId = addOptimisticAction({
      type: 'READ',
      threadIds,
      read: false,
    });

    patchListThreadsRead(threadIds, false);
    patchMailGetRead(threadIds, false);

    createPendingAction({
      type: 'READ',
      threadIds,
      params: { read: false },
      optimisticId,
      execute: async () => {
        await markAsUnread({ ids: threadIds });

        if (mail.bulkSelected.length > 0) {
          setMail({ ...mail, bulkSelected: [] });
        }
      },
      undo: () => {
        patchListThreadsRead(threadIds, true);
        patchMailGetRead(threadIds, true);
        removeOptimisticAction(optimisticId);
      },
      toastMessage: 'Marked as unread',
      skipRefresh: true,
    });
  }

  const optimisticToggleStar = useCallback(
    (threadIds: string[], starred: boolean) => {
      if (!threadIds.length) return;

      const optimisticId = addOptimisticAction({
        type: 'STAR',
        threadIds,
        starred,
      });

      // Same direct-patch pattern as mark-as-read: write the new state into
      // the listThreads cache so when the overlay is dropped the row reads
      // the right value, without depending on the post-RPC refetch landing
      // first.
      patchListThreadsTag(threadIds, 'STARRED', starred);

      createPendingAction({
        type: 'STAR',
        threadIds,
        params: { starred },
        optimisticId,
        execute: async () => {
          await toggleStar({ ids: threadIds, starred });
        },
        undo: () => {
          patchListThreadsTag(threadIds, 'STARRED', !starred);
          removeOptimisticAction(optimisticId);
        },
        toastMessage: starred
          ? m['common.actions.addedToFavorites']()
          : m['common.actions.removedFromFavorites'](),
        skipRefresh: true,
      });
    },
    [
      queryClient,
      addOptimisticAction,
      removeOptimisticAction,
      toggleStar,
      setMail,
      patchListThreadsTag,
    ],
  );

  function optimisticMoveThreadsTo(
    threadIds: string[],
    currentFolder: string,
    destination: ThreadDestination,
  ) {
    if (!threadIds.length || !destination) return;

    // setFocusedIndex(null);

    const optimisticId = addOptimisticAction({
      type: 'MOVE',
      threadIds,
      destination,
    });

    threadIds.forEach((id) => {
      setBackgroundQueue({ type: 'add', threadId: `thread:${id}` });
    });

    if (threadId && threadIds.includes(threadId)) {
      setThreadId(null);
      setActiveReplyId(null);
    }
    const successMessage =
      destination === 'inbox'
        ? m['common.actions.movedToInbox']()
        : destination === 'spam'
          ? m['common.actions.movedToSpam']()
          : destination === 'bin'
            ? m['common.actions.movedToBin']()
            : m['common.actions.archived']();

    createPendingAction({
      type: 'MOVE',
      threadIds,
      params: { currentFolder, destination },
      optimisticId,
      execute: async () => {
        await moveThreadsTo({
          threadIds,
          currentFolder,
          destination,
        });

        if (mail.bulkSelected.length > 0) {
          setMail({ ...mail, bulkSelected: [] });
        }

        threadIds.forEach((id) => {
          setBackgroundQueue({ type: 'delete', threadId: `thread:${id}` });
        });
      },
      undo: () => {
        removeOptimisticAction(optimisticId);
        threadIds.forEach((id) => {
          setBackgroundQueue({ type: 'delete', threadId: `thread:${id}` });
        });
      },
      toastMessage: successMessage,
      folders: [currentFolder, destination],
    });
  }

  function optimisticDeleteThreads(threadIds: string[], currentFolder: string) {
    if (!threadIds.length) return;

    // setFocusedIndex(null);

    const optimisticId = addOptimisticAction({
      type: 'MOVE',
      threadIds,
      destination: 'bin',
    });

    threadIds.forEach((id) => {
      setBackgroundQueue({ type: 'add', threadId: `thread:${id}` });
    });

    if (threadId && threadIds.includes(threadId)) {
      setThreadId(null);
      setActiveReplyId(null);
    }
    createPendingAction({
      type: 'MOVE',
      threadIds,
      params: { currentFolder, destination: 'bin' },
      optimisticId,
      execute: async () => {
        await bulkDeleteThread({ ids: threadIds, folder: currentFolder });

        if (mail.bulkSelected.length > 0) {
          setMail({ ...mail, bulkSelected: [] });
        }

        threadIds.forEach((id) => {
          setBackgroundQueue({ type: 'delete', threadId: `thread:${id}` });
        });
      },
      undo: () => {
        removeOptimisticAction(optimisticId);

        threadIds.forEach((id) => {
          setBackgroundQueue({ type: 'delete', threadId: `thread:${id}` });
        });
      },
      toastMessage: m['common.actions.movedToBin'](),
    });
  }

  const optimisticToggleImportant = useCallback(
    (threadIds: string[], isImportant: boolean) => {
      if (!threadIds.length) return;

      const optimisticId = addOptimisticAction({
        type: 'IMPORTANT',
        threadIds,
        important: isImportant,
      });

      patchListThreadsTag(threadIds, 'IMPORTANT', isImportant);

      createPendingAction({
        type: 'IMPORTANT',
        threadIds,
        params: { important: isImportant },
        optimisticId,
        execute: async () => {
          await toggleImportant({ ids: threadIds, important: isImportant });

          if (mail.bulkSelected.length > 0) {
            setMail((prev) => ({ ...prev, bulkSelected: [] }));
          }
        },
        undo: () => {
          patchListThreadsTag(threadIds, 'IMPORTANT', !isImportant);
          removeOptimisticAction(optimisticId);
        },
        toastMessage: isImportant ? 'Marked as important' : 'Unmarked as important',
        skipRefresh: true,
      });
    },
    [
      queryClient,
      addOptimisticAction,
      removeOptimisticAction,
      toggleImportant,
      setMail,
      patchListThreadsTag,
    ],
  );

  function optimisticToggleLabel(threadIds: string[], labelId: string, add: boolean) {
    if (!threadIds.length || !labelId) return;

    const optimisticId = addOptimisticAction({
      type: 'LABEL',
      threadIds,
      labelIds: [labelId],
      add,
    });

    createPendingAction({
      type: 'LABEL',
      threadIds,
      params: { labelId, add },
      optimisticId,
      execute: async () => {
        await modifyLabels({
          ids: threadIds,
          addLabels: add ? [labelId] : [],
          removeLabels: add ? [] : [labelId],
        });

        if (mail.bulkSelected.length > 0) {
          setMail({ ...mail, bulkSelected: [] });
        }
      },
      undo: () => {
        removeOptimisticAction(optimisticId);
      },
      toastMessage: add
        ? `Label added${threadIds.length > 1 ? ` to ${threadIds.length} threads` : ''}`
        : `Label removed${threadIds.length > 1 ? ` from ${threadIds.length} threads` : ''}`,
    });
  }

  function optimisticSnooze(threadIds: string[], currentFolder: string, wakeAt: Date) {
    if (!threadIds.length) return;

    const optimisticId = addOptimisticAction({
      type: 'SNOOZE',
      threadIds,
      wakeAt: wakeAt.toISOString(),
    });

    createPendingAction({
      type: 'SNOOZE',
      threadIds,
      params: { currentFolder, wakeAt: wakeAt.toISOString() },
      optimisticId,
      execute: async () => {
        await snoozeThreads({ ids: threadIds, until: wakeAt.toISOString() });

        if (mail.bulkSelected.length > 0) {
          setMail({ ...mail, bulkSelected: [] });
        }
      },
      undo: () => {
        removeOptimisticAction(optimisticId);
      },
      toastMessage: `Snoozed until ${wakeAt.toLocaleString()}`,
      folders: [currentFolder, 'snoozed'],
    });
  }

  function optimisticUnsnooze(threadIds: string[], currentFolder: string) {
    if (!threadIds.length) return;

    const optimisticId = addOptimisticAction({
      type: 'UNSNOOZE',
      threadIds,
    });

    createPendingAction({
      type: 'UNSNOOZE',
      threadIds,
      params: { currentFolder } as any,
      optimisticId,
      execute: async () => {
        await unsnoozeThreads({ ids: threadIds });
      },
      undo: () => {
        removeOptimisticAction(optimisticId);
      },
      toastMessage: 'Moved to Inbox',
      folders: [currentFolder, 'inbox'],
    });
  }

  function optimisticDeleteDraft(draftId: string) {
    if (!draftId) return;

    const optimisticId = addOptimisticAction({
      type: 'DELETE_DRAFT',
      threadIds: [draftId],
    });

    createPendingAction({
      type: 'DELETE_DRAFT',
      threadIds: [draftId],
      params: {} as any,
      optimisticId,
      execute: async () => {
        await deleteDraft({ id: draftId });
        await queryClient.invalidateQueries({ queryKey: trpc.drafts.list.queryKey() });
      },
      undo: () => {
        removeOptimisticAction(optimisticId);
      },
      toastMessage: 'Draft deleted',
    });
  }

  function undoLastAction() {
    if (!optimisticActionsManager.lastActionId) return;

    const lastAction = optimisticActionsManager.pendingActions.get(
      optimisticActionsManager.lastActionId,
    );
    if (!lastAction) return;

    lastAction.undo();

    optimisticActionsManager.pendingActions.delete(optimisticActionsManager.lastActionId);
    optimisticActionsManager.pendingActionsByType
      .get(lastAction.type)
      ?.delete(optimisticActionsManager.lastActionId);

    if (lastAction.toastId) {
      toast.dismiss(lastAction.toastId);
    }

    optimisticActionsManager.lastActionId = null;
  }

  return {
    optimisticMarkAsRead,
    optimisticMarkAsUnread,
    optimisticToggleStar,
    optimisticMoveThreadsTo,
    optimisticDeleteThreads,
    optimisticToggleImportant,
    optimisticToggleLabel,
    optimisticSnooze,
    optimisticUnsnooze,
    optimisticDeleteDraft,
    undoLastAction,
  };
}
