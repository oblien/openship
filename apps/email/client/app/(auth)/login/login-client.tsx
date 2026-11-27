/**
 * Login page - IMAP-credential sign-in.
 *
 * Posts to `/auth/sign-in` which runs an IMAP LOGIN against the
 * server's configured mail backend before issuing a session cookie.
 *
 * Host/port are deliberately NOT user-controllable - see
 * apps/email/server/src/lib/schemas.ts for the trust rationale.
 */

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ArrowUpRight, Eye, EyeOff } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { signIn } from '@/lib/auth-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useTRPC } from '@/providers/query-provider';
import { runtimeBranding } from '@/lib/runtime-branding';

import inboxPreview from './inbox-preview.webp';
import './login.css';

const footerLinks = [
  ['Docs', 'https://openship.io/docs'],
  ['Privacy', 'https://openship.io/privacy'],
  ['Terms', 'https://openship.io/terms'],
  ['GitHub', 'https://github.com/oblien/openship'],
];

export function LoginClient() {
  const trpc = useTRPC();
  const { data: branding } = useQuery({
    ...trpc.branding.get.queryOptions(),
    staleTime: 60_000,
  });
  const firstPaint = runtimeBranding();
  const heading = branding?.loginHeading ?? firstPaint.siteTitle;
  const showPoweredBy = branding?.showPoweredBy ?? firstPaint.showPoweredBy;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const submitPending = useRef(false);

  useEffect(() => {
    const hint = new URLSearchParams(window.location.hash.slice(1)).get('email');
    if (hint && hint.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(hint)) {
      setEmail(hint);
      window.history.replaceState(window.history.state, '', location.pathname + location.search);
    }
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitPending.current) return;
    submitPending.current = true;
    setSignInError(null);
    setSubmitting(true);
    try {
      const { error } = await signIn.email({ email, password });
      if (error) {
        setSignInError(error.message);
        return;
      }
      toast.success('Welcome back');
      // Hard navigate so root.tsx re-reads the active-id cookie just set
      // by /auth/sign-in and mounts the QueryClient under this mailbox's
      // namespaced IDB slot.
      window.location.href = '/mail/inbox';
    } catch (err) {
      setSignInError(err instanceof Error ? err.message : 'Sign in failed. Please try again.');
    } finally {
      submitPending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <main className="mail-login">
      <div className="mail-login__entry">
        <section className="mail-login__access" aria-labelledby="mail-login-title">
          <header className="mail-login__identity">
            <div className="mail-login__letters" aria-hidden="true">
              <img src="/mail.svg" alt="" width="515" height="344" />
              <img src="/opened-mail.svg" alt="" width="144" height="140" />
            </div>
            <h1 id="mail-login-title">{heading}</h1>
            {branding?.loginSubtext && <p className="mail-login__intro">{branding.loginSubtext}</p>}
          </header>

          <form className="mail-login__form" onSubmit={onSubmit}>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="email" className="block">
                  Email address
                </Label>
                <Input
                  variant="filled"
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password" className="block">
                  Password
                </Label>
                <div className="relative">
                  <Input
                    variant="filled"
                    id="password"
                    name="password"
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter password"
                    className="pe-11"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute end-0 inset-y-0 grid w-11 place-items-center rounded-xl text-muted-foreground hover:text-foreground focus-visible:outline-2"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
              </div>
            </div>

            {signInError && (
              <p role="alert" className="text-sm text-red-700 dark:text-red-300">
                {signInError}
              </p>
            )}
            <div className="mail-login__actions">
              <Button
                type="submit"
                isLoading={submitting}
                loadingText="Signing in"
                className="mail-login__submit"
              >
                Sign in <ArrowRight aria-hidden="true" />
              </Button>
              {branding?.createAccountUrl && (
                <a className="mail-login__signup" href={branding.createAccountUrl}>
                  Create account <ArrowUpRight aria-hidden="true" size={16} />
                </a>
              )}
            </div>
          </form>
        </section>

        <footer className="mail-login__footer">
          {branding?.loginFooter && <p>{branding.loginFooter}</p>}
          {showPoweredBy && (
            <nav aria-label="OpenShip resources">
              <a href="https://openship.io" target="_blank" rel="noopener noreferrer">
                Powered by OpenShip
              </a>
              {footerLinks.map(([label, href]) => (
                <a key={href} href={href} target="_blank" rel="noopener noreferrer">
                  {label}
                </a>
              ))}
            </nav>
          )}
        </footer>
      </div>

      <figure className="mail-login__preview">
        <figcaption>
          <h2>Email on your own domain.</h2>
          <p>Read and reply here, or open the same mailbox in Apple Mail or Outlook.</p>
        </figcaption>
        <div className="mail-login__stamp" aria-hidden="true">
          <img src="/mail-pixel.svg" alt="" width="44" height="44" />
        </div>
        <div className="mail-login__window">
          <img
            className="mail-login__screenshot"
            src={inboxPreview}
            alt="Webmail with folders on the left, a conversation list in the middle and an open message on the right."
            loading="lazy"
            width="2464"
            height="1360"
          />
        </div>
      </figure>
    </main>
  );
}
