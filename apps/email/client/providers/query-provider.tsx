import {
  PersistQueryClientProvider,
  type PersistedClient,
  type Persister,
} from "@tanstack/react-query-persist-client";
import { QueryCache, QueryClient, hashKey } from "@tanstack/react-query";
import { createTRPCContext } from "@trpc/tanstack-react-query";
import { createTRPCClient, httpBatchLink, httpBatchStreamLink, splitLink } from "@trpc/client";
import { useMemo, type PropsWithChildren } from "react";
import type { AppRouter } from "@zero/server/trpc";
import { CACHE_BURST_KEY } from "@/lib/constants";
import { signOut } from "@/lib/auth-client";
import { get, set, del } from "idb-keyval";
import superjson from "superjson";
import { shouldPersistQuery } from "@/lib/query-persistence";

function createIDBPersister(idbValidKey: IDBValidKey = "zero-query-cache") {
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
        if (meta && typeof meta.customError === "string") console.error(meta.customError);
        else if (
          err.message === "Required scopes missing" ||
          err.message.includes("Invalid connection")
        ) {
          signOut({
            fetchOptions: {
              onSuccess: () => {
                if (window.location.href.includes("/login")) return;
                window.location.href = "/login?error=required_scopes_missing";
              },
            },
          });
        } else console.error(err.message || "Something went wrong");
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
  if (typeof window === "undefined") {
    return makeQueryClient(connectionId);
  } else {
    if (!browserQueryClient.queryClient || browserQueryClient.activeConnectionId !== connectionId) {
      browserQueryClient.queryClient = makeQueryClient(connectionId);
      browserQueryClient.activeConnectionId = connectionId;
    }
    return browserQueryClient.queryClient;
  }
};

import { TRPC_URL } from "@/lib/backend-url";

const getUrl = () => TRPC_URL;

export const { TRPCProvider, useTRPC, useTRPCClient } = createTRPCContext<AppRouter>();

const authenticatedFetch: NonNullable<
  Parameters<typeof httpBatchLink<AppRouter>>[0]["fetch"]
> = async (url, options) => {
  const response = await fetch(url, { ...options, credentials: "include" });
  const redirectPath = response.headers.get("X-Zero-Redirect");
  if (redirectPath && redirectPath !== new URL(window.location.href).pathname) {
    window.location.href = redirectPath;
  }
  return response;
};

export const trpcClient = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      condition: (operation) => operation.path === "assistant.stream",
      true: httpBatchStreamLink({
        transformer: superjson,
        url: getUrl(),
        fetch: authenticatedFetch,
      }),
      false: httpBatchLink({
        transformer: superjson,
        url: getUrl(),
        methodOverride: "POST",
        maxItems: 1,
        fetch: authenticatedFetch,
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
    () => createIDBPersister(`zero-query-cache-${connectionId ?? "default"}`),
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
          shouldDehydrateQuery: shouldPersistQuery,
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
