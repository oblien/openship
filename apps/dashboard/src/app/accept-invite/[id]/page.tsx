"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Check, X } from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { api } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n, interpolate } from "@/components/i18n-provider";

type InviteState =
  | { kind: "loading" }
  | { kind: "needs-login"; email?: string; organizationName?: string }
  | { kind: "ready"; email: string; organizationName: string; role: string }
  | { kind: "accepting" }
  | { kind: "accepted"; organizationId: string; organizationName: string }
  | { kind: "error"; message: string };

/**
 * Module-level singleton — see TeamTab for the proxy-ref explanation.
 */
const orgClient = (authClient as unknown as {
  organization: {
    acceptInvitation: (opts: { invitationId: string }) => Promise<{ data?: { invitation: { organizationId: string }; member?: unknown }; error?: { message?: string } }>;
    rejectInvitation: (opts: { invitationId: string }) => Promise<{ error?: { message?: string } }>;
  };
}).organization;

export default function AcceptInvitePage() {
  const params = useParams();
  const router = useRouter();
  const { data: session, isPending: sessionLoading } = useSession();
  const { t } = useI18n();
  const m = t.misc.acceptInvite;
  const [state, setState] = useState<InviteState>({ kind: "loading" });
  // Inline "create account" form (self-host invite-only). We do NOT send people
  // to a public /register page — the account is created token-bound via
  // /api/system/invite-signup, then we sign in + accept.
  const [showSignup, setShowSignup] = useState(false);
  const [signupName, setSignupName] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [signupBusy, setSignupBusy] = useState(false);
  const [signupError, setSignupError] = useState<string | null>(null);

  const inviteId = String(params.id);

  // Once the invitation has been accepted, the effect must not re-run and
  // clobber the success screen: signing in (right after invite-signup) flips
  // `session`, which retriggers this effect, and a get-invitation for an
  // already-accepted invite now fails with "Invitation not found" — which
  // would paint an error over the success state.
  const settledRef = useRef(false);

  useEffect(() => {
    if (sessionLoading || settledRef.current) return;
    // Don't probe the invitation again mid-accept / after success — signing in
    // (invite-signup path) flips `session`, which retriggers this effect while
    // an accept is already in flight.
    if (state.kind === "accepting" || state.kind === "accepted") return;

    // A first-time invitee has no session yet, and better-auth's get-invitation
    // requires one — calling it here dead-ends every new invitee with an error
    // instead of the signup form. The invitation id in the URL is itself the
    // credential: /api/system/invite-signup re-validates it server-side
    // (pending, unexpired, admin inviter) and derives the email from it, so the
    // logged-out path goes straight to sign-in / create-account. Signed-in
    // users still get the full get-invitation details (org, role,
    // wrong-account detection).
    if (!session?.user) {
      setState({ kind: "needs-login" });
      return;
    }

    (async () => {
      try {
        // NOTE: better-auth's org client emits POST for this route while the
        // server registers it as GET-only — a guaranteed 404 (observed on
        // better-auth 1.5.4). Hit the endpoint directly with GET; the session
        // cookie rides along same-origin.
        const inv = await api.get<{
          email: string;
          role: string;
          status: string;
          organizationName?: string;
        }>(`auth/organization/get-invitation?id=${encodeURIComponent(inviteId)}`);
        // The accept may have completed while this request was in flight —
        // never paint a stale error over the success screen.
        if (settledRef.current) return;
        if (!inv?.email) {
          setState({ kind: "error", message: m.invalidInvitation });
          return;
        }
        if (inv.status !== "pending") {
          setState({
            kind: "error",
            message: interpolate(m.invitationStatus, { status: inv.status }),
          });
          return;
        }
        if (session.user.email !== inv.email) {
          setState({
            kind: "error",
            message: interpolate(m.wrongAccount, {
              email: inv.email,
              currentEmail: session.user.email,
            }),
          });
          return;
        }
        setState({
          kind: "ready",
          email: inv.email,
          organizationName: inv.organizationName ?? "",
          role: inv.role,
        });
      } catch (err) {
        setState({
          kind: "error",
          message: err instanceof Error ? err.message : m.loadFailed,
        });
      }
    })();
  }, [inviteId, session, sessionLoading, m]);

  const handleAccept = async () => {
    setState({ kind: "accepting" });
    const res = await orgClient.acceptInvitation({ invitationId: inviteId });
    if (res.error || !res.data) {
      setState({
        kind: "error",
        message: res.error?.message ?? m.acceptFailed,
      });
      return;
    }

    // Materialize any pending grants attached to this invitation. The
    // backend stored these at invite-with-grants time; we call the
    // materialize endpoint to write them as resource_grant rows scoped
    // to the new member's userId. Best-effort: if it fails we don't
    // block the accept — the user still becomes a member, they'll just
    // need an admin to add grants manually. Uses the api client so the
    // request targets the API origin (not the dashboard origin) in dev.
    try {
      await api.post(
        `permissions/invitations/${encodeURIComponent(inviteId)}/materialize`,
      );
    } catch (err) {
      console.warn("[accept-invite] materialize failed (continuing):", err);
    }

    settledRef.current = true;
    setState({
      kind: "accepted",
      organizationId: res.data.invitation.organizationId,
      organizationName: m.theOrganization,
    });
    setTimeout(() => router.push("/"), 1500);
  };

  const handleReject = async () => {
    await orgClient.rejectInvitation({ invitationId: inviteId });
    router.push("/");
  };

  // Create the account for the invited email (token-bound, server-side), then
  // sign in and accept. No public /register — the account can only be minted for
  // the invitation's own email via the invitation id.
  const handleInviteSignup = async (email: string) => {
    if (signupName.trim().length < 1) {
      setSignupError("Name is required");
      return;
    }
    if (signupPassword.length < 8) {
      setSignupError("Password must be at least 8 characters");
      return;
    }
    setSignupBusy(true);
    setSignupError(null);
    try {
      // The server derives the account email from the invitation token — the
      // response's email is authoritative, so sign in with it rather than any
      // client-side value.
      const created = await api.post<{ ok?: boolean; email?: string }>(
        "system/invite-signup",
        {
          invitationId: inviteId,
          name: signupName.trim(),
          password: signupPassword,
        },
      );
      const si = await authClient.signIn.email({
        email: created?.email || email,
        password: signupPassword,
      });
      if (si.error) {
        setSignupBusy(false);
        setSignupError(si.error.message ?? (m.acceptFailed ?? "Sign-in failed"));
        return;
      }
      await handleAccept();
    } catch (err) {
      setSignupBusy(false);
      setSignupError(getApiErrorMessage(err, m.acceptFailed ?? "Sign-up failed"));
      return;
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-2xl border border-border/50 bg-card p-6 space-y-5">
        {state.kind === "loading" || sessionLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : state.kind === "needs-login" ? (
          <>
            <div>
              <h1 className="text-xl font-semibold text-foreground">{m.invitedTitle}</h1>
              {state.organizationName && state.email ? (
                <p className="text-sm text-muted-foreground mt-2">
                  {m.needsLoginPre}
                  <strong>{state.organizationName}</strong>
                  {m.needsLoginMid}
                  <strong>{state.email}</strong>
                  {m.needsLoginPost}
                </p>
              ) : (
                <p className="text-sm text-muted-foreground mt-2">
                  {interpolate(m.joinTitle, { org: m.theOrganization })}
                </p>
              )}
            </div>
            {showSignup ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleInviteSignup(state.email || "");
                }}
              >
                <div className="flex flex-col gap-1">
                  <label htmlFor="invite-name" className="text-xs font-medium text-muted-foreground">
                    Name
                  </label>
                  <input
                    id="invite-name"
                    type="text"
                    autoComplete="name"
                    value={signupName}
                    onChange={(e) => setSignupName(e.target.value)}
                    className="w-full rounded-xl border border-border/50 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    required
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="invite-password" className="text-xs font-medium text-muted-foreground">
                    Password
                  </label>
                  <input
                    id="invite-password"
                    type="password"
                    autoComplete="new-password"
                    value={signupPassword}
                    onChange={(e) => setSignupPassword(e.target.value)}
                    className="w-full rounded-xl border border-border/50 bg-background px-3 py-2 text-sm outline-none focus:border-primary"
                    minLength={8}
                    required
                  />
                  <p className="text-[11px] text-muted-foreground">At least 8 characters.</p>
                </div>
                {signupError && <p className="text-xs text-destructive">{signupError}</p>}
                <button
                  type="submit"
                  disabled={signupBusy}
                  className="flex items-center justify-center gap-2 w-full py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60"
                >
                  {signupBusy && <Loader2 className="size-4 animate-spin" />}
                  {m.createAccount}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowSignup(false);
                    setSignupError(null);
                  }}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  {m.signIn}
                </button>
              </form>
            ) : (
              <div className="flex flex-col gap-2">
                <Link
                  href={`/auth/signin?redirect=${encodeURIComponent(`/accept-invite/${inviteId}`)}`}
                  className="block w-full text-center py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  {m.signIn}
                </Link>
                <button
                  type="button"
                  onClick={() => setShowSignup(true)}
                  className="block w-full text-center py-2.5 border border-border/50 rounded-xl text-sm font-medium hover:bg-muted/40 transition-colors"
                >
                  {m.createAccount}
                </button>
              </div>
            )}
          </>
        ) : state.kind === "ready" ? (
          <>
            <div>
              <h1 className="text-xl font-semibold text-foreground">
                {interpolate(m.joinTitle, { org: state.organizationName })}
              </h1>
              <p className="text-sm text-muted-foreground mt-2">
                {m.readyPre}
                <strong>{state.organizationName}</strong>
                {m.readyMid}
                <strong>{state.role}</strong>
                {m.readyPost}
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleReject}
                className="flex-1 py-2.5 border border-border/50 rounded-xl text-sm font-medium hover:bg-muted/40 transition-colors"
              >
                {m.decline}
              </button>
              <button
                type="button"
                onClick={handleAccept}
                className="flex-1 py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                {m.accept}
              </button>
            </div>
          </>
        ) : state.kind === "accepting" ? (
          <div className="flex items-center justify-center py-8 gap-3 text-sm text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
            {m.joining}
          </div>
        ) : state.kind === "accepted" ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-12 h-12 rounded-full bg-success-bg flex items-center justify-center">
              <Check className="size-6 text-success" />
            </div>
            <p className="text-base font-medium text-foreground">{m.acceptedTitle}</p>
            <p className="text-sm text-muted-foreground">{m.acceptedRedirect}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <X className="size-6 text-destructive" />
            </div>
            <p className="text-base font-medium text-foreground">{m.errorTitle}</p>
            <p className="text-sm text-muted-foreground">{state.message}</p>
            <Link
              href="/"
              className="mt-2 text-sm font-medium text-primary hover:underline"
            >
              {m.backToDashboard}
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
