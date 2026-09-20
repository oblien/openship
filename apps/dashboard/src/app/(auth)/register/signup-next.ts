/**
 * Where to go after a sign-up call returns.
 *
 * Extracted from the page because the branch got this wrong in a way no type could
 * catch. When an instance requires email verification, better-auth's sign-up
 * SUCCEEDS and answers `{ token: null, user }` with **no error** (see
 * `better-auth/dist/api/routes/sign-up.mjs` — the `requireEmailVerification`
 * path). The page read "no error" as "logged in", pushed `/`, and the app bounced
 * an unauthenticated visitor into a 401 — telling someone to sign in to the
 * account they had just created and could not yet use.
 *
 * The distinction that matters is therefore NOT error-vs-success, it is
 * session-vs-no-session.
 */

export type SignUpResultShape = {
  error?: { message?: string | null } | null;
  data?: { token?: string | null } | null;
};

export type SignUpNext =
  /** Show the message; stay on the form. */
  | { kind: "error"; message: string | null }
  /** Account exists, no session yet — the code screen, reachable unauthenticated. */
  | { kind: "verify"; href: string }
  /** A real session was issued; follow the post-login destination. */
  | { kind: "session"; href: string };

export function signUpNext(
  result: SignUpResultShape,
  opts: { email: string; postLoginUrl?: string | null },
): SignUpNext {
  const verifyHref = `/verify-email?email=${encodeURIComponent(opts.email)}`;

  if (result.error) {
    // Some deployments surface the requirement as an error instead of a null
    // token; both must land on the same screen.
    if (result.error.message?.toLowerCase().includes("verify")) {
      return { kind: "verify", href: verifyHref };
    }
    return { kind: "error", message: result.error.message ?? null };
  }

  // No token = no session. Never treat this as logged in.
  if (!result.data?.token) return { kind: "verify", href: verifyHref };

  return { kind: "session", href: opts.postLoginUrl || "/" };
}
