import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useNavigate,
  type MetaFunction,
} from 'react-router';
import { ServerProviders } from '@/providers/server-providers';
import { ClientProviders } from '@/providers/client-providers';
import Toaster from '@/components/ui/toast';
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import { useEffect, type PropsWithChildren } from 'react';
import type { AppRouter } from '@zero/server/trpc';
import { Button } from '@/components/ui/button';
import { getLocale } from '@/paraglide/runtime';
import { siteConfig } from '@/lib/site-config';
import { runtimeBranding } from '@/lib/runtime-branding';
import { signOut } from '@/lib/auth-client';
import { TRPC_URL } from '@/lib/backend-url';
import type { Route } from './+types/root';
import { AlertCircle } from 'lucide-react';
import { m } from '@/paraglide/messages';
import { ArrowLeft } from 'lucide-react';
import superjson from 'superjson';
import './globals.css';

const getUrl = () => TRPC_URL;

/**
 * Reads the active connection id from the non-httpOnly companion cookie
 * the server writes alongside `zero_session`. Used at boot to namespace
 * the persisted query cache per signed-in mailbox - so switching accounts
 * doesn't show stale data from the previous one, and each user keeps its
 * own offline cache.
 *
 * The cookie value is just a session id; the password lives in the
 * httpOnly cookie and never reaches JS.
 */
function readActiveConnectionId(): string | null {
  if (typeof document === 'undefined') return null;
  // Cookie name has to match SESSION_COOKIE_NAME + '_id' on the server.
  const match = document.cookie.match(/(?:^|;\s*)zero_session_id=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export const getServerTrpc = (req: Request) =>
  createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        maxItems: 1,
        url: getUrl(),
        transformer: superjson,
        headers: req.headers,
      }),
    ],
  });

export const meta: MetaFunction = () => {
  // Read from the document, not from the build-time siteConfig: the server has
  // already substituted the operator's branding into this <head>, and
  // re-rendering the constants here is what used to overwrite it (GH-568).
  const { siteTitle, siteDescription } = runtimeBranding();
  return [
    { title: siteTitle },
    { name: 'description', content: siteDescription },
    { property: 'og:title', content: siteTitle },
    { property: 'og:description', content: siteDescription },
    { property: 'og:image', content: siteConfig.openGraph.images[0].url },
    // `og:url` is intentionally omitted - siteConfig URLs are relative now
    // (one build deploys anywhere), and scrapers resolve relative og:image
    // against the page URL just fine. Adding a baked-in absolute here
    // would defeat the multi-host portability.
    { property: 'og:type', content: 'website' },
    { rel: 'manifest', href: '/manifest.webmanifest' },
  ];
};

export function Layout({ children }: PropsWithChildren) {
  return (
    <html lang={getLocale()} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#141414" media="(prefers-color-scheme: dark)" />
        <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)" />
        <link rel="icon" href="/favicon.ico" sizes="any" />
        <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
        <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.json" />
        <Meta />
        {import.meta.env.REACT_SCAN && (
          <script crossOrigin="anonymous" src="//unpkg.com/react-scan/dist/auto.global.js" />
        )}
        <Links />
      </head>
      <body className="antialiased">
        <ServerProviders connectionId={readActiveConnectionId()}>
          <ClientProviders>{children}</ClientProviders>
        </ServerProviders>
        <Toaster />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// export function HydrateFallback() {
//   return (
//     <div className="flex h-screen w-full items-center justify-center">
//       <Loader2 className="h-10 w-10 animate-spin" />
//     </div>
//   );
// }

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let message = 'Oops!';
  let details = 'An unexpected error occurred.';
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? '404' : 'Error';
    details =
      error.status === 404 ? 'The requested page could not be found.' : error.statusText || details;
    if (error.status === 404) {
      return <NotFound />;
    }
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  useEffect(() => {
    console.error(error);
    console.error({ message, details, stack });

    // Sentry error reporting was removed in Phase-1; self-hosted users
    // bring their own observability stack if any. Errors still log to
    // the console above.
  }, [error, message, details, stack]);

  return (
    <div className="dark:bg-background flex w-full items-center justify-center bg-white text-center">
      <div className="flex-col items-center justify-center md:flex dark:text-gray-100">
        {/* Message */}
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight">Something went wrong!</h2>
          <p className="text-muted-foreground">See the console for more information.</p>
          <pre className="text-muted-foreground">{JSON.stringify(error, null, 2)}</pre>
        </div>

        <div className="mt-2 flex gap-2">
          <Button
            variant="outline"
            onClick={() => window.location.reload()}
            className="text-muted-foreground gap-2"
          >
            Refresh
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              await signOut();
              window.location.href = '/login';
            }}
            className="text-muted-foreground gap-2"
          >
            Log Out and Refresh
          </Button>
        </div>
      </div>
    </div>
  );
}

function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="dark:bg-background flex w-full items-center justify-center bg-white text-center">
      <div className="flex-col items-center justify-center md:flex dark:text-gray-100">
        <div className="relative">
          <h1 className="text-muted-foreground/20 select-none text-[150px] font-bold">404</h1>
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
            <AlertCircle className="text-muted-foreground h-20 w-20" />
          </div>
        </div>

        {/* Message */}
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-tight">
            {m['pages.error.notFound.title']()}
          </h2>
          <p className="text-muted-foreground">{m['pages.error.notFound.description']()}</p>
        </div>

        {/* Buttons */}
        <div className="mt-2 flex justify-center gap-2">
          <Button
            variant="outline"
            onClick={() => navigate(-1)}
            className="text-muted-foreground gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            {m['pages.error.notFound.goBack']()}
          </Button>
        </div>
      </div>
    </div>
  );
}
