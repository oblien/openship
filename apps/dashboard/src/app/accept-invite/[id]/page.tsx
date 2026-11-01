"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { authClient, useSession } from "@/lib/auth-client";
import { needsTwoFactor } from "@/lib/account-security";
import { buildAuthPageHref } from "@/lib/cloud-auth";
import { api } from "@/lib/api";
import { getApiErrorMessage, setActiveOrganizationId } from "@/lib/api/client";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { InvitationDesktopLink } from "@/components/instance/InvitationDesktopLink";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useDialogFocus } from "@/hooks/useDialogFocus";
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
      role: string;
      inviterName?: string | null;
      accountCreation: InvitationAccountCreation;
    }
  | { kind: "ready"; email: string; organizationName: string; role: string; inviterName?: string | null }
  | { kind: "accepting" }
  | { kind: "accepted"; organizationId: string; organizationName: string }
  | { kind: "error"; message: string; wrongAccount?: boolean };

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
  const [desktop, setDesktop] = useState(false);
  useEffect(() => setDesktop(!!window.desktop?.isDesktop), []);
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
  // A session refresh must not let an older preview replace an acceptance.
  // Scope the attempt to this invitation so navigation also invalidates old work.
  const claimRef = useRef({ inviteId, phase: "idle" as "idle" | "accepting" | "accepted" });
  if (claimRef.current.inviteId !== inviteId) claimRef.current = { inviteId, phase: "idle" };
  const redirectRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (redirectRef.current) clearTimeout(redirectRef.current);
    if (claimRef.current.inviteId === inviteId) {
      claimRef.current = { inviteId, phase: "idle" };
    }
  }, [inviteId]);

  useEffect(() => {
    const claim = claimRef.current;
    if (sessionLoading || claim.phase !== "idle") return;

    let active = true;
    const current = () => active && claimRef.current === claim && claim.phase === "idle";

    void (async () => {
      try {
        if (!inviteId) {
          if (current()) setState({ kind: "error", message: m.invalidInvitation });
          return;
        }
        // Better Auth's getInvitation endpoint requires a session. The public
        // preview is token-bound and returns only what this claim page needs.
        const res = await api.get<InvitationPreviewResponse>(
          `auth/invitation-preview/${encodeURIComponent(inviteId)}`,
        );
        const { invitation, organization, inviter, accountCreation } = res.data;
        if (!current()) return;
        if (!session?.user) {
          setState({
            kind: "needs-login",
            email: invitation.email,
            organizationName: organization.name,
            role: invitation.role,
            inviterName: inviter?.name,
            accountCreation,
          });
          return;
        }
        if (!invitationEmailMatches(session.user.email, invitation.email)) {
          setState({
            kind: "error",
            wrongAccount: true,
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
          inviterName: inviter?.name,
        });
      } catch (err) {
        if (current()) {
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
    if (claimRef.current.inviteId !== inviteId || claimRef.current.phase !== "idle") return;
    const claim: typeof claimRef.current = { inviteId, phase: "accepting" };
    claimRef.current = claim;
    setState({ kind: "accepting" });
    try {
      const res = await orgClient.acceptInvitation({ invitationId: inviteId });
      if (claimRef.current !== claim) return;
      if (res.error || !res.data) {
        claim.phase = "idle";
        setState({
          kind: "error",
          message: res.error?.message ?? m.acceptFailed,
        });
        return;
      }

      // Acceptance commits membership and resource grants together, and selects
      // the remote session's organization. Keep the API header in the same scope.
      setActiveOrganizationId(res.data.invitation.organizationId);
      claim.phase = "accepted";
      setState({
        kind: "accepted",
        organizationId: res.data.invitation.organizationId,
        organizationName,
      });
      redirectRef.current = setTimeout(() => {
        if (claimRef.current === claim) router.push("/");
      }, 1500);
    } catch (err) {
      if (claimRef.current !== claim) return;
      claim.phase = "idle";
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
    if (needsTwoFactor(si.data)) {
      router.push(buildAuthPageHref("/two-factor", new URLSearchParams({ returnTo: `/accept-invite/${inviteId}` })));
      return;
    }
    await handleAccept(organizationName);
  };

  const content = (
      <div className="w-full rounded-2xl bg-card p-6 space-y-5">
        {state.kind === "loading" || sessionLoading ? (
          <div className="flex items-center justify-center py-8">
            <UiIcon name="spinner" className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : state.kind === "needs-login" ? (
          <>
            <div>
              <h1 className="text-xl font-semibold text-foreground">{m.invitedTitle}</h1>
              {state.inviterName && <p className="mt-1 text-sm text-muted-foreground">{interpolate(m.invitedBy, { name: state.inviterName })}</p>}
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
              <p className="mt-3 text-sm"><span className="text-muted-foreground">{m.roleLabel}</span> <span className="font-medium">{state.role}</span></p>
            </div>
            {!showSignup && <InvitationDesktopLink invitationId={inviteId} />}
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
                  <Input
                    id="invite-name"
                    type="text"
                    autoComplete="name"
                    value={signupName}
                    onChange={(e) => setSignupName(e.target.value)}
                    variant="filled"
                    className="bg-background"
                    required
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <label htmlFor="invite-password" className="text-xs font-medium text-muted-foreground">
                    {m.passwordLabel}
                  </label>
                  <Input
                    id="invite-password"
                    type="password"
                    autoComplete="new-password"
                    value={signupPassword}
                    onChange={(e) => setSignupPassword(e.target.value)}
                    variant="filled"
                    className="bg-background"
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
                  {signupBusy && <UiIcon name="spinner" className="size-4 animate-spin" />}
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
              {state.inviterName && <p className="mt-1 text-sm text-muted-foreground">{interpolate(m.invitedBy, { name: state.inviterName })}</p>}
              <p className="text-sm text-muted-foreground mt-2">
                {m.readyPre}
                <strong>{state.organizationName}</strong>
                {m.readyMid}
                <strong>{state.role}</strong>
                {m.readyPost}
              </p>
            </div>
            <InvitationDesktopLink invitationId={inviteId} />
            <div className="flex gap-2">
              <Button
                type="button"
                onClick={() => void handleReject()}
                variant="secondary"
                className="flex-1"
              >
                {m.decline}
              </Button>
              <Button
                type="button"
                onClick={() => void handleAccept(state.organizationName)}
                className="flex-1"
              >
                {m.accept}
              </Button>
            </div>
          </>
        ) : state.kind === "accepting" ? (
          <div className="flex items-center justify-center py-8 gap-3 text-sm text-muted-foreground">
            <UiIcon name="spinner" className="size-5 animate-spin" />
            {m.joining}
          </div>
        ) : state.kind === "accepted" ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-12 h-12 rounded-full bg-success-bg flex items-center justify-center">
              <UiIcon name="check" className="size-6 text-success" />
            </div>
            <p className="text-base font-medium text-foreground">{m.acceptedTitle}</p>
            <p className="text-sm text-muted-foreground">{m.acceptedRedirect}</p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <div className="w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
              <UiIcon name="close" className="size-6 text-destructive" />
            </div>
            <p className="text-base font-medium text-foreground">{m.errorTitle}</p>
            <p className="text-sm text-muted-foreground">{state.message}</p>
            {state.wrongAccount && (
              <Button onClick={() => {
                void authClient.signOut().then((result) => {
                  if (result.error) throw new Error(result.error.message ?? m.signInFailed);
                  window.location.assign(invitationLoginHref(inviteId));
                }).catch((err) => setState({ kind: "error", wrongAccount: true, message: getApiErrorMessage(err, m.signInFailed) }));
              }}>{m.switchAccount}</Button>
            )}
            <Link
              href="/"
              className="mt-2 text-sm font-medium text-primary hover:underline"
            >
              {m.backToDashboard}
            </Link>
          </div>
        )}
      </div>
  );
  return desktop ? (
    <DesktopInvitationDialog
      busy={state.kind === "accepting" || signupBusy}
      onClose={() => {
        if (claimRef.current.phase !== "accepting" && !signupBusy) router.push("/");
      }}
    >
      {content}
    </DesktopInvitationDialog>
  ) : (
    <div className="min-h-screen flex items-center justify-center bg-background p-6">
      <div className="w-full max-w-md">{content}</div>
    </div>
  );
}

function DesktopInvitationDialog({ children, busy, onClose }: {
  children: ReactNode;
  busy: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { dialog, onKeyDown } = useDialogFocus(onClose);
  return (
    <Modal isOpen onClose={onClose} closable={!busy} showCloseButton={false}
      maxWidth="min(480px, calc(100vw - 32px))" width="100%" maxHeight="90dvh" overflow="auto">
      <div ref={dialog} role="dialog" aria-modal="true" aria-label={t.misc.acceptInvite.invitedTitle}
        tabIndex={-1} onKeyDown={onKeyDown} className="relative outline-none [&_h1]:pe-8">
        <Button type="button" variant="ghost" size="icon" className="absolute end-3 top-3"
          aria-label={t.settings.common.close} disabled={busy} onClick={onClose}>
          <UiIcon name="close" />
        </Button>
        {children}
      </div>
    </Modal>
  );
}
