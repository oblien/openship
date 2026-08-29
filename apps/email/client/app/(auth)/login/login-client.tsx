/**
 * Login page - IMAP-credential sign-in.
 *
 * Posts to `/auth/sign-in` which runs an IMAP LOGIN against the
 * server's configured mail backend before issuing a session cookie.
 *
 * Host/port are deliberately NOT user-controllable - see
 * apps/email/server/src/lib/schemas.ts for the trust rationale.
 */

import { useState } from 'react';
import { Eye, EyeOff, Loader2, Lock, Mail } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { signIn } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTRPC } from '@/providers/query-provider';
import { runtimeBranding } from '@/lib/runtime-branding';

/** OpenShip mark - a hollow ring. Matches packages/dashboard's `<Logo>`. */
function OpenshipLogo({ size = 44 }: { size?: number }) {
  return (
    <div
      aria-hidden
      className="shrink-0 rounded-full border-[3px] border-foreground"
      style={{ width: size, height: size }}
    />
  );
}

/** Inline GitHub mark - lucide removed `Github` for trademark reasons. */
function GitHubMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 .5C5.65.5.5 5.65.5 12.02c0 5.1 3.29 9.42 7.86 10.95.58.1.79-.25.79-.56 0-.27-.01-1-.02-1.96-3.2.7-3.88-1.54-3.88-1.54-.52-1.34-1.28-1.7-1.28-1.7-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.2 1.77 1.2 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.7 0-1.26.45-2.28 1.2-3.08-.12-.3-.52-1.5.12-3.13 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.5 3.18-1.18 3.18-1.18.64 1.63.24 2.83.12 3.13.74.8 1.2 1.82 1.2 3.08 0 4.43-2.7 5.41-5.27 5.69.41.36.78 1.06.78 2.13 0 1.54-.01 2.78-.01 3.16 0 .31.21.67.8.56A11.52 11.52 0 0 0 23.5 12.02C23.5 5.65 18.35.5 12 .5Z" />
    </svg>
  );
}

const FALLBACK_BRANDING = {
  loginHeading: 'OpenShip Mail',
  loginSubtext: 'Sign in with your mailbox credentials',
  loginFooter: 'Self-hosted on your own mail server. No third parties.',
};

export function LoginClient() {
  const trpc = useTRPC();
  const { data: branding } = useQuery({
    ...trpc.branding.get.queryOptions(),
    staleTime: 60_000,
  });
  const heading = branding?.loginHeading ?? FALLBACK_BRANDING.loginHeading;
  const subtext = branding?.loginSubtext ?? FALLBACK_BRANDING.loginSubtext;
  const footer = branding?.loginFooter ?? FALLBACK_BRANDING.loginFooter;
  // Seeded from the value the server embedded in this document, so the row is
  // right on FIRST paint - the query result would arrive a beat later and flash
  // the vendor row in or out. The live query still wins once it resolves, so a
  // PATCH mid-session is picked up. Only an explicit `false` hides it.
  const showPoweredBy = branding?.showPoweredBy ?? runtimeBranding().showPoweredBy;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const { error } = await signIn.email({ email, password });
      if (error) {
        toast.error(error.message);
        return;
      }
      toast.success('Welcome back');
      // Hard navigate so root.tsx re-reads the active-id cookie just set
      // by /auth/sign-in and mounts the QueryClient under this mailbox's
      // namespaced IDB slot.
      window.location.href = '/mail/inbox';
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Sign in failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden bg-white dark:bg-[#0a0a0a]">
      {/* Background: three pastel gradient blobs. No overlays - the blobs
          ARE the design. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 -left-32 h-[440px] w-[440px] rounded-full opacity-60 blur-3xl dark:opacity-30"
        style={{ background: 'rgba(255, 213, 208, 1)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -bottom-40 -right-24 h-[500px] w-[500px] rounded-full opacity-60 blur-3xl dark:opacity-25"
        style={{ background: 'rgba(226, 214, 255, 1)' }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/3 left-1/2 h-[380px] w-[380px] -translate-x-1/2 rounded-full opacity-50 blur-3xl dark:opacity-20"
        style={{ background: 'rgba(219, 255, 228, 1)' }}
      />

      {/* Main */}
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-4 py-12">
        <div className="w-full max-w-[440px]">
          {/* Brand mark - OpenShip ring above the heading. */}
          <div className="mb-10 flex flex-col items-center text-center">
            <OpenshipLogo size={44} />
            <h1 className="mt-5 text-3xl font-semibold tracking-tight text-foreground sm:text-[34px]">
              {heading}
            </h1>
            <p className="mt-3 max-w-[340px] text-[15px] leading-relaxed text-muted-foreground">
              {subtext}
            </p>
          </div>

          {/* Card - extra rounded, soft glass over the gradient blobs. */}
          <form
            onSubmit={onSubmit}
            className="rounded-[28px] border border-black/[0.07] bg-white/75 p-8 shadow-[0_24px_56px_-20px_rgba(0,0,0,0.12),0_2px_4px_-2px_rgba(0,0,0,0.05)] backdrop-blur-2xl dark:border-white/[0.08] dark:bg-[#141414]/75 dark:shadow-[0_24px_56px_-20px_rgba(0,0,0,0.6)]"
          >
            <div className="space-y-5">
              <div className="space-y-2">
                <Label
                  htmlFor="email"
                  className="text-[13px] font-medium text-foreground/85"
                >
                  Email
                </Label>
                <div className="relative">
                  <Mail
                    aria-hidden
                    className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground/60"
                  />
                  <Input
                    id="email"
                    type="email"
                    autoComplete="email"
                    required
                    autoFocus
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="h-12 rounded-2xl border-black/[0.08] bg-white/80 pl-11 pr-4 text-[15px] transition-colors focus-visible:border-foreground/20 focus-visible:bg-white focus-visible:ring-1 focus-visible:ring-foreground/10 dark:border-white/[0.08] dark:bg-black/30 dark:focus-visible:border-white/20 dark:focus-visible:bg-black/50"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label
                  htmlFor="password"
                  className="text-[13px] font-medium text-foreground/85"
                >
                  Password
                </Label>
                <div className="relative">
                  <Lock
                    aria-hidden
                    className="pointer-events-none absolute left-4 top-1/2 h-[18px] w-[18px] -translate-y-1/2 text-muted-foreground/60"
                  />
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="h-12 rounded-2xl border-black/[0.08] bg-white/80 pl-11 pr-12 text-[15px] transition-colors focus-visible:border-foreground/20 focus-visible:bg-white focus-visible:ring-1 focus-visible:ring-foreground/10 dark:border-white/[0.08] dark:bg-black/30 dark:focus-visible:border-white/20 dark:focus-visible:bg-black/50"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    tabIndex={-1}
                    className="absolute right-3 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground/60 transition-colors hover:bg-foreground/5 hover:text-foreground"
                  >
                    {showPassword ? (
                      <EyeOff className="h-[18px] w-[18px]" />
                    ) : (
                      <Eye className="h-[18px] w-[18px]" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            <Button
              type="submit"
              disabled={submitting}
              className="mt-6 h-12 w-full rounded-2xl bg-foreground text-[15px] font-medium text-background shadow-[0_2px_10px_-2px_rgba(0,0,0,0.2)] transition-all hover:bg-foreground/90 disabled:opacity-60"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Signing in
                </>
              ) : (
                'Sign in'
              )}
            </Button>
          </form>

          <p className="mt-7 text-center text-[13px] leading-relaxed text-muted-foreground">
            {footer}
          </p>
        </div>
      </main>

      {/* Footer - transparent, no border, no glass. Sits flush over the
          gradient. Vendor chrome: hidden entirely when the operator has
          branded this deployment (GH-568). */}
      {showPoweredBy && (
        <footer className="relative z-10">
          <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-6 py-6 sm:flex-row">
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              <span>Powered by</span>
              <a
                href="https://openship.io"
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-foreground transition-colors hover:text-foreground/70"
              >
                OpenShip
              </a>
            </div>
            <nav className="flex items-center gap-6 text-[13px] text-muted-foreground">
              <a
                href="https://openship.io/docs"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-foreground"
              >
                Docs
              </a>
              <a
                href="https://openship.io/privacy"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-foreground"
              >
                Privacy
              </a>
              <a
                href="https://openship.io/terms"
                target="_blank"
                rel="noopener noreferrer"
                className="transition-colors hover:text-foreground"
              >
                Terms
              </a>
              <a
                href="https://github.com/oblien/openship"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="GitHub"
                className="inline-flex items-center gap-1.5 transition-colors hover:text-foreground"
              >
                <GitHubMark className="h-4 w-4" />
                <span className="hidden sm:inline">GitHub</span>
              </a>
            </nav>
          </div>
        </footer>
      )}
    </div>
  );
}
