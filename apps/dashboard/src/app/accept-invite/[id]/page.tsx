"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, Check, X } from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { api } from "@/lib/api";
import { getApiErrorMessage } from "@/lib/api/client";
import { useI18n, interpolate } from "@/components/i18n-provider";
import {
  invitationEmailMatches,
  invitationLoginHref,
  invitationRegisterHref,
  type InvitationAccountCreation,
  type InvitationPreviewResponse,
} from "@/lib/invitation-flow";

type InviteState =
  | { kind: "loading" }
  | {
      kind: "needs-login";
      email: string;
      organizationName: string;
      accountCreation: InvitationAccountCreation;
    }
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

  const inviteId = Array.isArray(params.id) ? params.id[0] ?? "" : String(params.id ?? "");

  useEffect(() => {
    if (sessionLoading) return;

    let active = true;

    void (async () => {
      try {
        if (!inviteId) {
          if (active) setState({ kind: "error", message: m.invalidInvitation });
          return;
        }
        // Better Auth's getInvitation endpoint requires a session. The public
        // preview is token-bound and returns only what this claim page needs.
        const res = await api.get<InvitationPreviewResponse>(
          `auth/invitation-preview/${encodeURIComponent(inviteId)}`,
        );
        const { invitation, organization, accountCreation } = res.data;
        if (!active) return;
        if (!session?.user) {
          setState({
            kind: "needs-login",
            email: invitation.email,
            organizationName: organization.name,
            accountCreation,
          });
          return;
        }
        if (!invitationEmailMatches(session.user.email, invitation.email)) {
          setState({
            kind: "error",
            message: interpolate(m.wrongAccount, {
              email: invitation.email,
              currentEmail: session.user.email,
            }),
          });
          return;
        }
        setState({
          kind: "ready",
          email: invitation.email,
          organizationName: organization.name,
          role: invitation.role,
        });
      } catch (err) {
        if (active) {
          setState({
            kind: "error",
            message: getApiErrorMessage(err, m.loadFailed),
          });
        }
      }
    })();

    return () => {
      active = false;
    };
  }, [inviteId, session?.user?.email, sessionLoading, m]);

  const handleAccept = async (organizationName: string) => {
    setState({ kind: "accepting" });
    try {
      const res = await orgClient.acceptInvitation({ invitationId: inviteId });
      if (res.error || !res.data) {
        setState({
          kind: "error",
          message: res.error?.message ?? m.acceptFailed,
        });
        return;
      }

      // Materialize any pending grants attached to this invitation. The
      // membership itself remains successful if this best-effort enrichment
      // fails; an admin can still add grants from the member row.
      try {
        await api.post(
          `permissions/invitations/${encodeURIComponent(inviteId)}/materialize`,
        );
      } catch (err) {
        console.warn("[accept-invite] materialize failed (continuing):", err);
      }

      setState({
        kind: "accepted",
        organizationId: res.data.invitation.organizationId,
        organizationName,
      });
      setTimeout(() => router.push("/"), 1500);
    } catch (err) {
      setState({
        kind: "error",
        message: getApiErrorMessage(err, m.acceptFailed),
      });
    }
  };

  const handleReject = async () => {
    try {
      const res = await orgClient.rejectInvitation({ invitationId: inviteId });
      if (res.error) {
        setState({ kind: "error", message: res.error.message ?? m.rejectFailed });
        return;
      }
      router.push("/");
    } catch (err) {
      setState({ kind: "error", message: getApiErrorMessage(err, m.rejectFailed) });
    }
  };

  // Create the account for the invited email (token-bound, server-side), then
  // sign in and accept. No public /register — the account can only be minted for
  // the invitation's own email via the invitation id.
  const handleInviteSignup = async (email: string, organizationName: string) => {
    if (signupName.trim().length < 1) {
      setSignupError(m.nameRequired);
      return;
    }
    if (signupPassword.length < 8) {
      setSignupError(m.passwordMin);
      return;
    }
    setSignupBusy(true);
    setSignupError(null);
    try {
      await api.post("system/invite-signup", {
        invitationId: inviteId,
        name: signupName.trim(),
        password: signupPassword,
      });
    } catch (err) {
      setSignupBusy(false);
      setSignupError(getApiErrorMessage(err, m.signupFailed));
      return;
    }
    const si = await authClient.signIn.email({ email, password: signupPassword });
    if (si.error) {
      setSignupBusy(false);
      setSignupError(si.error.message ?? m.signInFailed);
      return;
    }
    await handleAccept(organizationName);
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
              <p className="text-sm text-muted-foreground mt-2">
                {state.accountCreation === "invited" || state.accountCreation === "public"
                  ? <>
                      {m.needsLoginPre}
                      <strong>{state.organizationName}</strong>
                      {m.needsLoginMid}
                      <strong>{state.email}</strong>
                      {m.needsLoginPost}
                    </>
                  : interpolate(m.signInToAccept, {
                      org: state.organizationName,
                      email: state.email,
                    })}
              </p>
            </div>
            {state.accountCreation === "disabled" && (
              <p className="rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-muted-foreground">
                {m.accountCreationDisabled}
              </p>
            )}
            {showSignup && state.accountCreation === "invited" ? (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleInviteSignup(state.email, state.organizationName);
                }}
              >
                <div className="flex flex-col gap-1">
                  <label htmlFor="invite-name" className="text-xs font-medium text-muted-foreground">
                    {m.nameLabel}
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
                    {m.passwordLabel}
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
                  <p className="text-[11px] text-muted-foreground">{m.passwordHint}</p>
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
                  href={invitationLoginHref(inviteId)}
                  className="block w-full text-center py-2.5 bg-primary text-primary-foreground rounded-xl text-sm font-medium hover:bg-primary/90 transition-colors"
                >
                  {m.signIn}
                </Link>
                {state.accountCreation === "invited" ? (
                  <button
                    type="button"
                    onClick={() => setShowSignup(true)}
                    className="block w-full text-center py-2.5 border border-border/50 rounded-xl text-sm font-medium hover:bg-muted/40 transition-colors"
                  >
                    {m.createAccount}
                  </button>
                ) : state.accountCreation === "public" ? (
                  <Link
                    href={invitationRegisterHref(inviteId)}
                    className="block w-full text-center py-2.5 border border-border/50 rounded-xl text-sm font-medium hover:bg-muted/40 transition-colors"
                  >
                    {m.createAccount}
                  </Link>
                ) : null}
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
                onClick={() => void handleReject()}
                className="flex-1 py-2.5 border border-border/50 rounded-xl text-sm font-medium hover:bg-muted/40 transition-colors"
              >
                {m.decline}
              </button>
              <button
                type="button"
                onClick={() => void handleAccept(state.organizationName)}
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
