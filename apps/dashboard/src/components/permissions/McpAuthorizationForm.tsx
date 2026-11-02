"use client";

import { reportCaughtError as observeCaughtError } from "@repo/core/diagnostics";
import { Icon as UiIcon } from "@repo/ui/icons";
import { PermissionReviewSkeleton } from "./PermissionReviewSkeleton";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { authClient, useSession } from "@/lib/auth-client";
import { interpolate } from "@/components/i18n-provider";
import {
  tokensApi,
  githubApi,
  resourceTypeLabel,
  type CatalogEntry,
  type ResourceType,
} from "@/lib/api";
import { setActiveOrganizationId, getApiErrorMessage } from "@/lib/api/client";
import { useDeploymentInfo } from "@/hooks/useDeploymentInfo";
import {
  dropRejectedGrant,
  grantableTypes,
  isUnscopedTemplate,
  labelKey,
  reduceSelection,
  templateGrants,
  wireGrants,
  wouldSilentlyGrantEverything,
  authorizeBlockedReason,
  type AccessSelection,
  type ScopeAction,
  type TemplateContext,
} from "./mcp-access-templates";
import { AccessControlEditor } from "./AccessControlEditor";
import {
  AccessCopyProvider,
  ASSISTANT_ACCESS_COPY,
  CHAT_ACCESS_COPY,
  useAccessCopy,
} from "./access-copy";
import { ConsentActions } from "./ConsentActions";
import DropdownMenu from "@/components/ui/DropdownMenu";

interface Props {
  clientId: string | null;
  consentCode: string | null;
  /** Inline clients are bound to the workspace where the authorization began. */
  organizationId?: string;
  presentation?: "mcp" | "assistant" | "chat";
  onComplete(redirectURI: string | null, accepted: boolean): Promise<void> | void;
  onUnauthorized?(): void;
  onBusyChange?(busy: boolean): void;
}

/** One consent form and submission path for external clients and the built-in assistant. */
export function McpAuthorizationForm(props: Props) {
  return (
    <AccessCopyProvider
      value={
        props.presentation === "chat"
          ? CHAT_ACCESS_COPY
          : props.presentation === "assistant"
            ? ASSISTANT_ACCESS_COPY
            : undefined
      }
    >
      <AuthorizationForm {...props} />
    </AccessCopyProvider>
  );
}

interface Org {
  id: string;
  name: string;
  /** Better Auth's organization logo, when the org has one set. */
  logo?: string | null;
}

/**
 * Better Auth wraps the organization plugin in a Proxy that returns a fresh
 * reference per access, so capture it once at module scope (see AccountSwitcher
 * for the full rationale — using it inline as an effect dep loops forever).
 */
const orgClient = (
  authClient as unknown as {
    organization: {
      list: () => Promise<{ data?: Org[] }>;
      setActive: (opts: {
        organizationId: string;
      }) => Promise<{ error?: { message?: string } | null }>;
      getFullOrganization: () => Promise<{ data?: { id: string } | null }>;
    };
  }
).organization;

/** Consent POST → `{ redirectURI }`. Uses the auth client so the cookie session
 *  + auth base URL are handled for us. */
async function postConsent(accept: boolean, consentCode: string | null): Promise<string | null> {
  const res = await (
    authClient as unknown as {
      $fetch: (
        path: string,
        opts: { method: string; body: Record<string, unknown> },
      ) => Promise<{ data?: { redirectURI?: string } | null; error?: { status?: number } | null }>;
    }
  ).$fetch("/oauth2/consent", {
    method: "POST",
    body: { accept, ...(consentCode ? { consent_code: consentCode } : {}) },
  });
  if (res.error) {
    const status = res.error.status;
    throw Object.assign(new Error("consent failed"), { status });
  }
  return res.data?.redirectURI ?? null;
}

function AuthorizationForm({
  clientId,
  consentCode,
  organizationId: boundOrganizationId,
  presentation = "mcp",
  onComplete,
  onUnauthorized,
  onBusyChange,
}: Props) {
  const embedded = presentation !== "mcp";
  // The shared auth store may already be populated when navigating from Assistant.
  // Keep its first client render identical to the server's loading state.
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const { data: session, isPending } = useSession();
  const m = useAccessCopy();
  const pending = useRef(false);

  const [submitting, setSubmitting] = useState<null | "accept" | "deny">(null);
  const [error, setError] = useState<string | null>(null);
  /** A grant the server refused, dropped for the user so they can retry. */
  const [rejected, setRejected] = useState<string | null>(null);

  const selfHosted = useDeploymentInfo()?.selfHosted ?? true;
  const availableTypes = useMemo(() => grantableTypes(selfHosted), [selfHosted]);

  // ── GitHub accounts for the default template ──────────────────────────────
  // From /api/github/home, NOT the permissions catalog: `home` runs
  // filterAllowedAccounts so it returns exactly what THIS user may re-grant,
  // whereas the permissions catalog is fetched as the org owner and is
  // unfiltered — seeding from it 403s at mint for a non-owner admin.
  const [githubAccounts, setGithubAccounts] = useState<string[]>([]);
  const ctx = useMemo<TemplateContext>(() => ({ githubAccounts }), [githubAccounts]);

  // ── The scope ─────────────────────────────────────────────────────────────
  // Seeded with the safe default. It re-seeds once the GitHub accounts arrive
  // (see the catalogReady action) as long as the user hasn't edited it.
  // The reducer needs the live catalog to relabel a selection, but making `ctx` a
  // reducer arg would rebuild the dispatcher on every catalog change. A ref keeps
  // dispatch stable; safe because `reduceSelection` is pure given ctx (so a
  // StrictMode double-invoke is idempotent) and the only dispatch that depends on
  // a FRESH ctx runs from an effect keyed on it, i.e. after this assignment.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;
  const [selection, dispatch] = useReducer(
    (state: AccessSelection, action: ScopeAction) => reduceSelection(state, action, ctxRef.current),
    undefined,
    (): AccessSelection => ({
      template: presentation === "chat" ? "readOnly" : "agent",
      grants: templateGrants(presentation === "chat" ? "readOnly" : "agent", {
        githubAccounts: [],
      }),
      readOnly: presentation === "chat",
    }),
  );

  // ── Catalog labels, so the summary shows names instead of cuids ───────────
  const [labels, setLabels] = useState<ReadonlyMap<string, string>>(new Map());
  const onCatalogLoaded = useCallback((type: ResourceType, entries: CatalogEntry[]) => {
    setLabels((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const e of entries) {
        const key = labelKey(type, e.id);
        if (next.get(key) !== e.label) {
          next.set(key, e.label);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  // ── Org binding ───────────────────────────────────────────────────────────
  // The org the client will be confined to. Defaults to the active org; a
  // multi-org user can pick another. Changing it SWITCHES the session's active
  // org (like the account switcher) so the resource picker + grant validation
  // scope to the same org the token binds to — otherwise you'd scope one org's
  // resources into another org's binding.
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgId, setOrgId] = useState<string | null>(null);
  const [orgSwitching, setOrgSwitching] = useState(false);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      orgClient.list().catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/permissions/authorization");
        return { data: [] as Org[] };
      }),
      orgClient.getFullOrganization().catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/permissions/authorization");
        return { data: null };
      }),
    ]).then(([listRes, activeRes]) => {
      if (cancelled) return;
      const list = listRes.data ?? [];
      setOrgs(list);
      setOrgId(
        boundOrganizationId
          ? list.some((org) => org.id === boundOrganizationId)
            ? boundOrganizationId
            : null
          : ((activeRes.data as { id: string } | null)?.id ?? list[0]?.id ?? null),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [boundOrganizationId]);

  // GitHub accounts are org-scoped, so this re-runs per org and re-seeds the
  // template. A box with no GitHub connected resolves to [] and the default
  // degrades to create-only rather than failing.
  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    githubApi
      .getUserHome()
      .then((home: { accounts?: Array<{ login?: string }> } | null) => {
        if (cancelled) return;
        const logins = (home?.accounts ?? [])
          .map((a) => a.login)
          .filter((l): l is string => typeof l === "string" && l.length > 0);
        setGithubAccounts(logins);
      })
      .catch((diagnosticFailure) => {
        observeCaughtError(diagnosticFailure, "dashboard/components/permissions/authorization");
        if (!cancelled) setGithubAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  // Re-seed a pristine preset once the accounts land. `ctx` is the dep, so this
  // fires exactly when the resolved account list changes.
  useEffect(() => {
    dispatch({ type: "catalogReady" });
  }, [ctx]);

  const handleOrgChange = useCallback(
    async (next: string) => {
      setOrgSwitching(true);
      setError(null);
      setRejected(null);
      try {
        // Switch the session server-side so ctx.organizationId (and thus the
        // picker's catalog + minterHasAccess) follows. Only commit the local
        // selection once the switch lands — on failure the picker stays on the
        // org it's actually scoped to.
        const res = await orgClient.setActive({ organizationId: next });
        if (res?.error) {
          setError(m.switchOrgError);
          return;
        }
        setActiveOrganizationId(next);
        // Every resource id in the selection belonged to the previous org, so the
        // scope resets to the default rather than carrying ids that would fail
        // validation — or, worse, name another org's resources. Labels go too.
        setLabels(new Map());
        setGithubAccounts([]);
        dispatch({ type: "pickTemplate", id: "agent" });
        setOrgId(next);
      } catch (diagnosticFailure) {
        observeCaughtError(diagnosticFailure, "dashboard/components/permissions/authorization");
        setError(m.switchOrgError);
      } finally {
        setOrgSwitching(false);
      }
    },
    [m],
  );

  const busy = submitting !== null || orgSwitching;
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);
  const activeOrg = orgs.find((o) => o.id === orgId);
  const orgName = activeOrg?.name ?? m.thisOrganization;
  const canAuthorize = !!orgId && authorizeBlockedReason(selection) === null;

  const act = useCallback(
    async (accept: boolean) => {
      if (pending.current || orgSwitching || (accept && !canAuthorize)) return;
      setError(null);
      setRejected(null);

      // Belt and braces against the one mistake that matters here: an empty
      // scoped selection would be sent as zero grants and recorded as an
      // UNSCOPED binding. The button is disabled for this, so reaching it means
      // a bug, not a user action.
      if (accept && wouldSilentlyGrantEverything(selection)) {
        setError(m.blockedNoResources);
        return;
      }

      pending.current = true;
      setSubmitting(accept ? "accept" : "deny");
      try {
        // Record the client's scope BEFORE issuing a token, so the binding
        // exists when the OAuth token first authenticates. Skip on deny.
        if (accept && clientId) {
          await tokensApi.mcpAuthorize({
            clientId,
            readOnly: selection.readOnly,
            grants: wireGrants(selection),
            organizationId: orgId ?? undefined,
            // State the intent the guard above just proved: only a template whose
            // card says "no limits" in words may send an empty grant list. The
            // server rejects an empty list without this, so a future UI bug that
            // trims a scoped selection to nothing fails loudly instead of minting
            // an unscoped binding.
            fullAccess: isUnscopedTemplate(selection.template),
          });
        }
        const redirectURI = await postConsent(accept, consentCode);
        await onComplete(redirectURI, accept);
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401 && onUnauthorized) {
          onUnauthorized();
          return;
        }
        // 403 GRANT_EXCEEDS_ACCESS names the grant the user can't re-grant. Drop
        // exactly that one and let them authorize again, instead of dead-ending
        // on a generic error — this is reachable through no fault of theirs (the
        // GitHub tree's catalog is broader than a non-owner admin's own access).
        const recovery =
          status === 403 ? dropRejectedGrant(selection.grants, getApiErrorMessage(err, "")) : null;
        if (recovery) {
          dispatch({
            type: "removeGrant",
            resourceType: recovery.dropped.resourceType,
            resourceId: recovery.dropped.resourceId,
          });
          setRejected(
            `${resourceTypeLabel(recovery.dropped.resourceType)} · ${recovery.dropped.resourceId}`,
          );
          setSubmitting(null);
          return;
        }
        setError(m.authorizeError);
      } finally {
        pending.current = false;
        setSubmitting(null);
      }
    },
    [
      clientId,
      selection,
      orgId,
      consentCode,
      orgSwitching,
      canAuthorize,
      onComplete,
      onUnauthorized,
      m,
    ],
  );

  if (!hydrated || isPending) {
    if (presentation === "assistant") return <PermissionReviewSkeleton />;
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <UiIcon name="spinner" className="size-5 animate-spin" />
      </div>
    );
  }

  // The full-page route owns sign-in redirects; a dialog stays in place.
  if (!session) {
    return (
      <p role="alert" className="p-6 text-sm text-muted-foreground">
        {m.signInRequiredBody}
      </p>
    );
  }

  if (!clientId) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-danger-border bg-danger-bg p-4 text-sm text-danger">
        <UiIcon name="alert-circle" className="mt-0.5 size-4 shrink-0" />
        {m.missingClientId}
      </div>
    );
  }

  // The org lives in the header next to the account: it's identity, and it's what
  // bounds every grant below. A single-org user gets a plain chip (nothing to
  // choose); a multi-org user gets the same chip as a click-to-switch menu.
  const orgLogo = activeOrg?.logo ? (
    // eslint-disable-next-line @next/next/no-img-element -- remote logo, no loader configured
    <img
      src={activeOrg.logo}
      alt=""
      aria-hidden
      className="size-4 shrink-0 rounded bg-muted object-cover"
    />
  ) : (
    <span
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center rounded bg-muted/60 text-[8px] font-semibold uppercase text-muted-foreground"
    >
      {orgName.slice(0, 2)}
    </span>
  );

  const orgChip =
    !boundOrganizationId && orgs.length > 1 ? (
      <DropdownMenu
        align="left"
        disabled={busy}
        actions={orgs.map((o) => ({
          id: o.id,
          label: o.name,
          icon: o.id === orgId ? <UiIcon name="check" className="size-3.5" /> : undefined,
          onClick: () => void handleOrgChange(o.id),
        }))}
        trigger={
          <span
            title={m.orgScopeNote}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-border/60 px-2 py-1 transition-colors hover:bg-muted/40"
          >
            {orgLogo}
            <span className="truncate font-medium text-foreground">{orgName}</span>
            {orgSwitching ? (
              <UiIcon name="spinner" className="size-3 shrink-0 animate-spin" />
            ) : (
              <UiIcon name="chevron-down" className="size-3 shrink-0 text-muted-foreground" />
            )}
          </span>
        }
      />
    ) : (
      <span className="inline-flex min-w-0 items-center gap-1.5" title={m.orgScopeNote}>
        {orgLogo}
        <span className="truncate font-medium text-foreground">{orgName}</span>
      </span>
    );

  return (
    <div className={embedded ? "flex min-h-0 flex-1 flex-col" : undefined}>
      {/* Header spans both columns — it's the question being asked. The identity
          used to be a card of its own below this; it was three lines of chrome
          for no interaction, so it's a single meta line here instead. */}
      <div
        className={
          embedded ? "flex shrink-0 items-start gap-3 p-6 pe-14" : "mb-6 flex items-start gap-3"
        }
      >
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-muted/60 text-foreground">
          <UiIcon
            name={presentation === "chat" ? "message" : embedded ? "sparkles" : "mcp"}
            className="size-5"
          />
        </div>
        <div className="min-w-0">
          <h1 className="text-lg font-semibold text-foreground">{m.title}</h1>
          <p className="text-sm text-muted-foreground">{m.subtitle}</p>
          {/* Who is granting, and into which org. The raw client_id used to sit
              here; it's an opaque random string a user can't verify anything
              from, whereas the org is what actually bounds the grant. */}
          <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="flex min-w-0 items-center gap-1.5">
              {session?.user?.image ? (
                // eslint-disable-next-line @next/next/no-img-element -- remote avatar, no loader configured
                <img
                  src={session.user.image}
                  alt=""
                  aria-hidden
                  className="size-4 shrink-0 rounded-full bg-muted object-cover"
                />
              ) : null}
              <span className="truncate font-medium text-foreground">{session?.user?.email}</span>
            </span>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            {orgChip}
          </div>
        </div>
      </div>

      {/* One editor, shared with the settings MCP tab, token creation and member
          grants. The reducer stays HERE on purpose: the component must not be able
          to default a selection, because the edit surface prefills from the server
          and a component-owned default would silently replace a live scope. */}
      <div className={embedded ? "min-h-0 flex-1 overflow-y-auto px-6 pb-6" : undefined}>
        <AccessControlEditor
          layout={embedded ? "dialog" : "two-column"}
          templates={presentation === "chat" ? ["readOnly", "existing", "full"] : undefined}
          defaultTemplate={presentation === "chat" ? "readOnly" : "agent"}
          show={presentation === "chat" ? { createCapability: false } : undefined}
          selection={selection}
          dispatch={dispatch}
          availableTypes={availableTypes}
          ctx={ctx}
          orgKey={orgId ?? "none"}
          orgName={orgName}
          labels={labels}
          onCatalogLoaded={onCatalogLoaded}
          disabled={busy || !orgId}
          notice={
            <>
              {rejected && (
                <div className="rounded-xl border border-warning-border bg-warning-bg p-3.5 text-xs text-warning">
                  <p className="flex items-start gap-2 font-medium">
                    <UiIcon name="alert-circle" className="mt-0.5 size-3.5 shrink-0" />
                    {m.grantRejectedTitle}
                  </p>
                  <p className="mt-1 ps-5 leading-relaxed">
                    {interpolate(m.grantRejected, { resource: rejected })}
                  </p>
                </div>
              )}

              {error && (
                <div className="flex items-start gap-2 rounded-xl border border-danger-border bg-danger-bg p-3.5 text-sm text-danger">
                  <UiIcon name="alert-circle" className="mt-0.5 size-4 shrink-0" />
                  {error}
                </div>
              )}
            </>
          }
          footer={
            !embedded && (
              <ConsentActions
                variant="rail"
                busy={busy}
                submitting={submitting}
                canAuthorize={canAuthorize}
                onDeny={() => act(false)}
                onAuthorize={() => act(true)}
              />
            )
          }
        />
      </div>

      {embedded ? (
        <ConsentActions
          variant="inline"
          busy={busy}
          submitting={submitting}
          canAuthorize={canAuthorize}
          onDeny={() => void act(false)}
          onAuthorize={() => void act(true)}
        />
      ) : (
        <>
          <div className="h-20 lg:hidden" aria-hidden />
          <ConsentActions
            variant="fixed"
            busy={busy}
            submitting={submitting}
            canAuthorize={canAuthorize}
            onDeny={() => void act(false)}
            onAuthorize={() => void act(true)}
          />
        </>
      )}
    </div>
  );
}
