"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@repo/ui/icons";
import { reportCaughtError } from "@repo/core/diagnostics";
import { authClient, signOut } from "@/lib/auth-client";
import { setActiveOrganizationId } from "@/lib/api/client";
import { useI18n } from "@/components/i18n-provider";
import { Button } from "@/components/ui/button";

interface Organization {
  id: string;
  name: string;
  logo?: string | null;
}
interface Identity {
  user: { id: string; name?: string | null; email: string; image?: string | null };
  session: { activeOrganizationId?: string | null };
}
// Capture the Better Auth proxy once; its getters otherwise change on every render.
const organization = (
  authClient as unknown as {
    organization: {
      list: () => Promise<{ data?: Organization[] | null; error?: { message?: string } | null }>;
      setActive: (input: {
        organizationId: string;
      }) => Promise<{ data?: unknown; error?: { message?: string } | null }>;
    };
  }
).organization;

/** Shared consent identity for Desktop, hosted instances and CLI device login.
 * Organization selection changes the real session; it never grants access itself. */
export function CloudAuthorizationIdentity({
  session,
  loginUrl,
  disabled,
  children,
}: {
  session: Identity;
  loginUrl: string;
  disabled: boolean;
  children: (ready: boolean) => ReactNode;
}) {
  return (
    <IdentityPanel
      key={`${session.user.id}:${session.session.activeOrganizationId ?? ""}`}
      session={session}
      loginUrl={loginUrl}
      disabled={disabled}
    >
      {children}
    </IdentityPanel>
  );
}

function IdentityPanel({
  session,
  loginUrl,
  disabled,
  children,
}: Parameters<typeof CloudAuthorizationIdentity>[0]) {
  const { t } = useI18n();
  const m = t.misc.cloudAuthorize;
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<"account" | string | null>(null);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    setError(null);
    organization
      .list()
      .then((result) => {
        if (cancelled) return;
        if (result.error || !Array.isArray(result.data)) throw new Error(m.organizationsError);
        setOrgs(result.data);
      })
      .catch((failure) => {
        reportCaughtError(failure, "dashboard/components/cloud/CloudAuthorizationIdentity");
        if (!cancelled) {
          setLoadError(true);
          setError(m.organizationsError);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [attempt, m.organizationsError]);
  const active = orgs.find((org) => org.id === session.session.activeOrganizationId);
  const blocked = disabled || loading || busy !== null;
  async function switchOrganization(id: string) {
    if (blocked || locked.current || !orgs.some((org) => org.id === id)) return;
    if (id === active?.id) {
      setChoosing(false);
      return;
    }
    locked.current = true;
    setBusy(id);
    setError(null);
    try {
      const result = await organization.setActive({ organizationId: id });
      if (!mounted.current) return;
      if (result.error || !result.data) throw new Error(m.switchOrganizationError);
      setActiveOrganizationId(id);
      // Reload the same consent request, with its state and PKCE intact, so the
      // identity comes from the new cookie session before Authorize is enabled.
      window.location.reload();
    } catch (failure) {
      reportCaughtError(failure, "dashboard/components/cloud/CloudAuthorizationIdentity");
      if (mounted.current) {
        setError(m.switchOrganizationError);
        setBusy(null);
        locked.current = false;
      }
    }
  }
  async function switchAccount() {
    if (disabled || busy !== null || locked.current) return;
    locked.current = true;
    setBusy("account");
    setError(null);
    try {
      const result = await signOut();
      if (!mounted.current) return;
      if (result.error || !result.data) throw new Error(m.switchAccountError);
      setActiveOrganizationId(null);
      // A full navigation prevents the auth layout reusing the old session.
      window.location.href = loginUrl;
    } catch (failure) {
      reportCaughtError(failure, "dashboard/components/cloud/CloudAuthorizationIdentity");
      if (mounted.current) {
        setError(m.switchAccountError);
        setBusy(null);
        locked.current = false;
      }
    }
  }
  return (
    <>
      <div className="mb-6 overflow-hidden rounded-2xl bg-card">
        <div className="flex items-center gap-3 p-4 sm:p-5">
          <IdentityAvatar
            image={session.user.image}
            name={session.user.name || session.user.email}
            icon="user"
          />
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs text-muted-foreground">{m.signedInAs}</p>
            <p className="truncate text-sm font-medium text-foreground">
              {session.user.name || session.user.email}
            </p>
            {session.user.name && session.user.name !== session.user.email && (
              <p
                className="mt-0.5 truncate text-xs text-muted-foreground"
                title={session.user.email}
              >
                {session.user.email}
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || busy !== null}
            aria-label={m.switchAccount}
            onClick={() => void switchAccount()}
          >
            {busy === "account" ? (
              <Icon name="spinner" className="size-4 animate-spin" />
            ) : (
              m.switch
            )}
          </Button>
        </div>
        <div className="mx-4 h-px bg-border/60 sm:mx-5" />
        <div className="flex items-center gap-3 p-4 sm:p-5">
          <IdentityAvatar image={active?.logo} name={active?.name} icon="building" />
          <div className="min-w-0 flex-1">
            <p className="mb-1 text-xs text-muted-foreground">{m.organization}</p>
            {loading ? (
              <div
                className="h-4 w-32 animate-pulse rounded bg-muted"
                aria-label={m.loadingOrganizations}
              />
            ) : (
              <p className="truncate text-sm font-medium text-foreground" title={active?.name}>
                {active?.name || m.chooseOrganization}
              </p>
            )}
          </div>
          {!loadError && (orgs.length > 1 || (!active && orgs.length > 0)) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={blocked}
              aria-label={m.switchOrganization}
              aria-expanded={choosing}
              onClick={() => setChoosing((value) => !value)}
            >
              {busy && busy !== "account" ? (
                <Icon name="spinner" className="size-4 animate-spin" />
              ) : active ? (
                m.switch
              ) : (
                m.choose
              )}
            </Button>
          )}
        </div>
        {choosing && !loading && (
          <div
            className="max-h-64 space-y-1 overflow-y-auto px-3 pb-3"
            role="group"
            aria-label={m.switchOrganization}
          >
            {orgs.map((org) => (
              <button
                key={org.id}
                type="button"
                disabled={blocked}
                aria-pressed={org.id === active?.id}
                onClick={() => void switchOrganization(org.id)}
                className="flex w-full items-center gap-3 rounded-xl p-3 text-start transition-colors hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
              >
                <IdentityAvatar image={org.logo} name={org.name} icon="building" small />
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">{org.name}</span>
                {org.id === active?.id && (
                  <Icon name="check" className="size-4 text-muted-foreground" />
                )}
              </button>
            ))}
            {!orgs.length && (
              <p className="px-3 py-2 text-sm text-muted-foreground">{m.noOrganizations}</p>
            )}
          </div>
        )}
      </div>
      {error && (
        <div className="mb-4 rounded-xl bg-danger/10 p-3 text-sm text-danger" role="alert">
          <p>{error}</p>
          {loadError && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              disabled={disabled || busy !== null}
              onClick={() => setAttempt((value) => value + 1)}
            >
              {m.retry}
            </Button>
          )}
        </div>
      )}
      {!loading && !loadError && !active && (
        <div className="mb-4 text-sm text-muted-foreground" role="status">
          <p>{orgs.length ? m.chooseOrganizationHint : m.noOrganizations}</p>
          {!orgs.length && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="mt-2"
              disabled={disabled || busy !== null}
              onClick={() => setAttempt((value) => value + 1)}
            >
              {m.retry}
            </Button>
          )}
        </div>
      )}
      {children(Boolean(active && !loading && !loadError && busy === null))}
    </>
  );
}

function IdentityAvatar({
  image,
  name,
  icon,
  small = false,
}: {
  image?: string | null;
  name?: string | null;
  icon: "user" | "building";
  small?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  return (
    <div
      className={`flex shrink-0 items-center justify-center overflow-hidden rounded-xl bg-muted/60 ${small ? "size-8" : "size-11"}`}
    >
      {image && !failed ? (
        <img
          src={image}
          alt=""
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
          className="size-full object-cover"
        />
      ) : name && icon === "user" ? (
        <span className="text-sm font-medium text-foreground" aria-hidden="true">
          {name.trim().slice(0, 1).toUpperCase()}
        </span>
      ) : (
        <Icon
          name={icon}
          className={small ? "size-4 text-muted-foreground" : "size-5 text-muted-foreground"}
          aria-hidden="true"
        />
      )}
    </div>
  );
}
