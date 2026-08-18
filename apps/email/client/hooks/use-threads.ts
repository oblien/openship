import { backgroundQueueAtom, isThreadInBackgroundQueueAtom } from '@/store/backgroundQueue';
import { useInfiniteQuery, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { ThreadResponse as IGetThreadResponse } from '../../server/src/lib/imap-driver';
import { useSearchValue } from '@/hooks/use-search-value';
import { useTRPC } from '@/providers/query-provider';
import useSearchLabels from './use-labels-search';
import { useSession } from '@/lib/auth-client';
import { useAtom, useAtomValue } from 'jotai';
import { useSettings } from './use-settings';
import { useParams } from 'react-router';
import { useTheme } from 'next-themes';
import { useQueryState } from 'nuqs';
import { useMemo } from 'react';

export const useThreads = () => {
  const { folder } = useParams<{ folder: string }>();
  const [searchValue] = useSearchValue();
  const [backgroundQueue] = useAtom(backgroundQueueAtom);
  const isInQueue = useAtomValue(isThreadInBackgroundQueueAtom);
  const trpc = useTRPC();
  const { labels } = useSearchLabels();

  const threadsQuery = useInfiniteQuery(
    trpc.mail.listThreads.infiniteQueryOptions(
      {
        q: searchValue.value,
        folder,
        labelIds: labels,
      },
      {
        initialCursor: '',
        getNextPageParam: (lastPage) => lastPage?.nextPageToken ?? null,
        // No background revalidation. The list refreshes only when a
        // user action invalidates it (mark-as-read, star, move, delete,
        // explicit refresh button). Without this, stale-while-revalidate
        // refetches were overwriting a just-marked row with the older
        // server snapshot and visibly "reverting" the action.
        staleTime: 10000,
        refetchInterval: 30000,
        refetchOnMount: true,
        refetchOnWindowFocus: true,
      },
    ),
  );

  // Flatten threads from all pages and sort by receivedOn date (newest first)

  const threads = useMemo(() => {
    return threadsQuery.data
      ? threadsQuery.data.pages
          .flatMap((e) => e.threads)
          .filter(Boolean)
          .filter((e) => !isInQueue(`thread:${e.id}`))
      : [];
  }, [threadsQuery.data, threadsQuery.dataUpdatedAt, isInQueue, backgroundQueue]);

  const isEmpty = useMemo(() => threads.length === 0, [threads]);
  const isReachingEnd =
    isEmpty ||
    (threadsQuery.data &&
      !threadsQuery.data.pages[threadsQuery.data.pages.length - 1]?.nextPageToken);

  const loadMore = async () => {
    if (threadsQuery.isLoading || threadsQuery.isFetching) return;
    await threadsQuery.fetchNextPage();
  };

  return [threadsQuery, threads, isReachingEnd, loadMore] as const;
};

export const useThread = (threadId: string | null, options?: { enabled?: boolean }) => {
  const { data: session } = useSession();
  const [_threadId] = useQueryState('threadId');
  const id = threadId ? threadId : _threadId;
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: settings } = useSettings();
  const { theme: systemTheme } = useTheme();
  // Pass the current folder through so the server searches the right
  // mailbox (Sent/Drafts/Trash/etc.). Without this, `mail.get` defaults
  // to INBOX and returns 404 for any thread you click in Sent, Drafts,
  // Trash, Archive, or Spam.
  const { folder } = useParams<{ folder: string }>();

  // UID hint - walk every cached `mail.listThreads` page (any folder /
  // search filter / label combo) looking for the row whose id matches.
  // When found, hand the UID + UIDVALIDITY back to the server so it can
  // resolve via a single FETCH instead of the O(N) SEARCH HEADER scan.
  // Cache misses (direct URL navigation, post-restart) just take the
  // slow path - never a correctness issue, only latency.
  const uidHint = useMemo(() => {
    if (!id) return undefined;
    type CachedListPage = {
      threads?: Array<{ id?: string; uid?: number; uidValidity?: number }>;
    };
    type CachedListData = { pages?: CachedListPage[] } | undefined;
    const queries = queryClient.getQueriesData<CachedListData>({
      queryKey: [['mail', 'listThreads']],
    });
    for (const [, data] of queries) {
      const pages = data?.pages;
      if (!pages) continue;
      for (const page of pages) {
        const row = page.threads?.find((t) => t.id === id);
        if (row && typeof row.uid === 'number' && typeof row.uidValidity === 'number') {
          return { uid: row.uid, uidValidity: row.uidValidity };
        }
      }
    }
    return undefined;
  }, [id, queryClient]);

  const threadQuery = useQuery(
    trpc.mail.get.queryOptions(
      {
        id: id!,
        folder,
        uidHint,
      },
      {
        enabled: (options?.enabled ?? true) && !!id && !!session?.user.id,
        // Same rationale as listThreads above - never refetch on mount,
        // focus, or interval. The optimistic-action layer invalidates
        // mail.get explicitly after every flag change.
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
      },
    ),
  );

  const { latestDraft, isGroupThread, finalData, latestMessage } = useMemo(() => {
    if (!threadQuery.data) {
      return {
        latestDraft: undefined,
        isGroupThread: false,
        finalData: undefined,
        latestMessage: undefined,
      };
    }

    const latestDraft = threadQuery.data.latest?.id
      ? threadQuery.data.messages.findLast((e) => e.isDraft)
      : undefined;

    const isGroupThread = threadQuery.data.latest?.id
      ? (() => {
          const totalRecipients = [
            ...(threadQuery.data.latest.to || []),
            ...(threadQuery.data.latest.cc || []),
            ...(threadQuery.data.latest.bcc || []),
          ].length;
          return totalRecipients > 1;
        })()
      : false;

    const nonDraftMessages = threadQuery.data.messages.filter((e) => !e.isDraft);
    const latestMessage = nonDraftMessages[nonDraftMessages.length - 1];

    const finalData: IGetThreadResponse = {
      ...threadQuery.data,
      messages: nonDraftMessages,
    };

    return { latestDraft, isGroupThread, finalData, latestMessage };
  }, [threadQuery.data]);

  const { mutateAsync: processEmailContent } = useMutation(
    trpc.mail.processEmailContent.mutationOptions(),
  );

  // Extract image loading condition to avoid duplication
  const shouldLoadImages = useMemo(() => {
    if (!settings?.settings || !latestMessage?.sender?.email) return false;
    
    return settings.settings.externalImages ||
      settings.settings.trustedSenders?.includes(latestMessage.sender.email) ||
      false;
  }, [settings?.settings, latestMessage?.sender?.email]);

  // Prefetch query - intentionally unused, just for caching
  useQuery({
    queryKey: [
      'email-content',
      latestMessage?.id,
      shouldLoadImages,
      systemTheme,
    ],
    queryFn: async () => {
      if (!latestMessage?.decodedBody || !settings?.settings) return null;

      const userTheme =
        settings.settings.colorTheme === 'system' ? systemTheme : settings.settings.colorTheme;
      const theme = userTheme === 'dark' ? 'dark' : 'light';

      const result = await processEmailContent({
        html: latestMessage.decodedBody,
        shouldLoadImages,
        theme,
      });

      return {
        html: result.processedHtml,
        hasBlockedImages: result.hasBlockedImages,
      };
    },
    enabled: !!latestMessage?.decodedBody && !!settings?.settings,
    staleTime: 30 * 60 * 1000, // 30 minutes
    gcTime: 60 * 60 * 1000, // 1 hour
    refetchOnWindowFocus: false,
    refetchOnMount: false,
  });

  return { ...threadQuery, data: finalData, isGroupThread, latestDraft };
};
