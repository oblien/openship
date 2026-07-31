import {
  PersistQueryClientProvider,
  type PersistedClient,
  type Persister,
} from '@tanstack/react-query-persist-client';
import { QueryCache, QueryClient, hashKey } from '@tanstack/react-query';
import { createTRPCContext } from '@trpc/tanstack-react-query';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { useMemo, type PropsWithChildren } from 'react';
import type { AppRouter } from '@zero/server/trpc';
import { CACHE_BURST_KEY } from '@/lib/constants';
import { signOut } from '@/lib/auth-client';
import { get, set, del } from 'idb-keyval';
import superjson from 'superjson';

function createIDBPersister(idbValidKey: IDBValidKey = 'zero-query-cache') {
  return {
    persistClient: async (client: PersistedClient) => {
      await set(idbValidKey, client);
    },
    restoreClient: async () => {
      return await get<PersistedClient>(idbValidKey);
    },
    removeClient: async () => {
      await del(idbValidKey);
    },
  } satisfies Persister;
}

export const makeQueryClient = (connectionId: string | null) =>
  new QueryClient({
    queryCache: new QueryCache({
      onError: (err, { meta }) => {
        if (meta && meta.noGlobalError === true) return;
        if (meta && typeof meta.customError === 'string') console.error(meta.customError);
        else if (
          err.message === 'Required scopes missing' ||
          err.message.includes('Invalid connection')
        ) {
          signOut({
            fetchOptions: {
              onSuccess: () => {
                if (window.location.href.includes('/login')) return;
                window.location.href = '/login?error=required_scopes_missing';
              },
            },
          });
        } else console.error(err.message || 'Something went wrong');
      },
    }),
    defaultOptions: {
      queries: {
        retry: false,
        refetchOnWindowFocus: false,
        queryKeyHashFn: (queryKey) => hashKey([{ connectionId }, ...queryKey]),
        gcTime: 1000 * 60 * 60 * 24, // 24 hours,
      },
      mutations: {
        onError: (err) => console.error(err.message),
      },
    },
  });

let browserQueryClient = {
  queryClient: null,
  activeConnectionId: null,
} as {
  queryClient: QueryClient | null;
  activeConnectionId: string | null;
};

const getQueryClient = (connectionId: string | null) => {
  if (typeof window === 'undefined') {
    return makeQueryClient(connectionId);
  } else {
    if (!browserQueryClient.queryClient || browserQueryClient.activeConnectionId !== connectionId) {
      browserQueryClient.queryClient = makeQueryClient(connectionId);
      browserQueryClient.activeConnectionId = connectionId;
    }
    return browserQueryClient.queryClient;
  }
};

import { TRPC_URL } from '@/lib/backend-url';

const getUrl = () => TRPC_URL;

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    // loggerLink({ enabled: () => true }),
    httpBatchLink({
      transformer: superjson,
      url: getUrl(),
      methodOverride: 'POST',
      maxItems: 1,
      fetch: (url, options) =>
        fetch(url, { ...options, credentials: 'include' }).then((res) => {
          const currentPath = new URL(window.location.href).pathname;
          const redirectPath = res.headers.get('X-Zero-Redirect');
          if (!!redirectPath && redirectPath !== currentPath) {
            window.location.href = redirectPath;
            res.headers.delete('X-Zero-Redirect');
          }
          return res;
        }),
    }),
  ],
});

type TrpcHook = ReturnType<typeof useTRPC>;
export function QueryProvider({
  children,
  connectionId,
}: PropsWithChildren<{ connectionId: string | null }>) {
  const persister = useMemo(
    () => createIDBPersister(`zero-query-cache-${connectionId ?? 'default'}`),
    [connectionId],
  );
  const queryClient = useMemo(() => getQueryClient(connectionId), [connectionId]);

  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        buster: CACHE_BURST_KEY,
        maxAge: 1000 * 60 * 60 * 24, // 24 hours
        // Never persist mail/draft state - IDB write is debounced, so a
        // mark-as-read followed by a quick refresh could restore the old
        // unread badge until the background refetch landed (or lose the
        // update entirely if IDB hadn't synced yet). Settings, labels,
        // and connection data are slow-changing and safe to persist.
        dehydrateOptions: {
          shouldDehydrateQuery: (query) => {
            // Match the library default (only persist settled/successful
            // queries). Without this, a query that's still pending when the
            // debounced persist fires gets dehydrated with its live in-flight
            // `promise` attached (see dehydrateQuery in @tanstack/query-core),
            // and idb-keyval's IndexedDB put() throws a DataCloneError trying
            // to structured-clone that Promise - surfacing as a generic
            // "Uncaught (in promise)" console error on nearly every persist.
            if (query.state.status !== 'success') return false;
            const head = query.queryKey?.[0];
            const path = Array.isArray(head) ? head : [];
            const root = typeof path[0] === 'string' ? path[0] : '';
            if (root === 'mail' || root === 'drafts') return false;
            return true;
          },
        },
      }}
      onSuccess={() => {
        // Mail queries aren't persisted (see dehydrateOptions above), so
        // there's nothing to slice or invalidate on restore - the active
        // mount triggers a fresh fetch.
      }}
    >
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    </PersistQueryClientProvider>
  );
}
