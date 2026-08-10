"use client";

/**
 * /mcp/authorize — OAuth 2.1 consent screen for MCP clients.
 *
 * Better Auth's mcp() plugin redirects here (its `consentPage`) mid-authorize
 * with `client_id`, `scope`, and a `consent_code` in the query. We authenticate
 * the browser against the Better Auth cookie session, show what's connecting,
 * and on an explicit Approve POST to `/api/auth/oauth2/consent`
 * (`{ accept, consent_code }`) — which returns a `redirectURI` that continues
 * the flow back to the client.
 *
 * Lives top-level (not under (auth)/(dashboard)) because it's for an
 * AUTHENTICATED visitor; we wrap AuthShell manually for visual parity with
 * /login and /cloud-authorize. Since it's outside the dashboard layout there's
 * no PlatformProvider — the SaaS-vs-self-hosted split for the resource picker
 * comes from the `useDeploymentInfo` hook instead of `usePlatform`.
 *
 * ── Shape ────────────────────────────────────────────────────────────────────
 * Two columns. LEFT: who's connecting, the template cards, and the editor.
 * RIGHT (sticky): the editable summary of exactly what Authorize will grant, its
 * plain-language consequences, and the buttons.
 *
 * All scope logic — template → grants, relabelling, the blocked states, the
 * capability digest — lives in components/permissions/mcp-access-templates.ts so
 * it can be unit-tested (this app has no DOM test setup). This file is wiring.
 */

import { Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, Boxes, AlertCircle, Check, ChevronDown } from "lucide-react";
import { authClient, useSession } from "@/lib/auth-client";
import { AuthShell } from "@/components/auth-shell";
import { useI18n, interpolate } from "@/components/i18n-provider";
import {
  tokensApi,
  githubApi,
  resourceTypeLabel,
  type CatalogEntry,
  type PickerGrant,
  type ResourceType,
} from "@/lib/api";
import { setActiveOrganizationId, getApiErrorMessage } from "@/lib/api/client";
import { useDeploymentInfo } from "@/hooks/useDeploymentInfo";
import {
  applyTemplate,
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
  type AccessTemplateId,
  type ScopeAction,
  type TemplateContext,
} from "@/components/permissions/mcp-access-templates";
import { TemplatePicker } from "./_components/TemplatePicker";
import { ScopeEditor } from "./_components/ScopeEditor";
import { ScopeSummary } from "./_components/ScopeSummary";
import { ActionBar } from "./_components/ActionBar";
import { RailScroll } from "./_components/RailScroll";
import DropdownMenu from "@/components/ui/DropdownMenu";

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
const orgClient = (authClient as unknown as {
  organization: {
    list: () => Promise<{ data?: Org[] }>;
    setActive: (opts: { organizationId: string }) => Promise<{ error?: { message?: string } | null }>;
    getFullOrganization: () => Promise<{ data?: { id: string } | null }>;
  };
}).organization;

/**
 * Marks a return trip from /login, so the bounce can happen AT MOST ONCE.
 *
 * The two sides of this handshake each redirect on their own condition: this page
 * goes to /login when its client session reads empty, and `(auth)/layout` comes
 * straight back here when it sees a session cookie + an allowlisted `returnTo`.
 * If those two ever disagree — and in the MCP-initiated flow they do — the result
 * is an unbounded redirect storm between the dashboard and the API rather than a
 * login form. (Before `/mcp/authorize` was allowlisted in validateReturnTo this
 * same disagreement existed; it just dead-ended silently on `/` instead.)
 *
 * With the marker the page bounces once, and if it lands back here still without a
 * session it stops and asks the user to sign in explicitly. One extra query param
 * buys a hard guarantee of termination, which is worth more here than saving a
 * click in an already-broken state.
 */
const RETRY_PARAM = "signedIn";

function buildLoginHref(searchParams: URLSearchParams): string {
  const back = new URLSearchParams(searchParams.toString());
  back.set(RETRY_PARAM, "1");
  const qs = back.toString();
  return `/login?returnTo=${encodeURIComponent(`/mcp/authorize?${qs}`)}`;
}

/** Consent POST → `{ redirectURI }`. Uses the auth client so the cookie session
 *  + auth base URL are handled for us. */
async function postConsent(accept: boolean, consentCode: string | null): Promise<string | null> {
  const res = await (authClient as unknown as {
    $fetch: (
      path: string,
      opts: { method: string; body: Record<string, unknown> },
    ) => Promise<{ data?: { redirectURI?: string } | null; error?: { status?: number } | null }>;
  }).$fetch("/oauth2/consent", {
    method: "POST",
    body: { accept, ...(consentCode ? { consent_code: consentCode } : {}) },
  });
  if (res.error) {
    const status = res.error.status;
    throw Object.assign(new Error("consent failed"), { status });
  }
  return res.data?.redirectURI ?? null;
}

function McpAuthorizeInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session, isPending } = useSession();
  const { t } = useI18n();
  const m = t.misc.mcpAuthorize;

  const clientId = searchParams.get("client_id");
  const consentCode = searchParams.get("consent_code");

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
      template: "agent",
      grants: templateGrants("agent", { githubAccounts: [] }),
      readOnly: false,
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
      orgClient.list().catch(() => ({ data: [] as Org[] })),
      orgClient.getFullOrganization().catch(() => ({ data: null })),
    ]).then(([listRes, activeRes]) => {
      if (cancelled) return;
      const list = listRes.data ?? [];
      setOrgs(list);
      setOrgId((activeRes.data as { id: string } | null)?.id ?? list[0]?.id ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
      .catch(() => {
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
      } catch {
        setError(m.switchOrgError);
      } finally {
        setOrgSwitching(false);
      }
    },
    [m],
  );

  const busy = submitting !== null || orgSwitching;
  const activeOrg = orgs.find((o) => o.id === orgId);
  const orgName = activeOrg?.name ?? m.thisOrganization;
  const canAuthorize = authorizeBlockedReason(selection) === null;

  const act = useCallback(
    async (accept: boolean) => {
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
        if (redirectURI) {
          window.location.href = redirectURI; // continue the OAuth flow
          return;
        }
        // No redirect (e.g. denied with no return) — send the user home.
        router.replace("/");
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status === 401) {
          router.replace(
            buildLoginHref(new URLSearchParams(searchParams.toString())),
          );
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
        setSubmitting(null);
      }
    },
    [clientId, selection, orgId, consentCode, router, searchParams, m],
  );

  const onPickTemplate = useCallback((id: AccessTemplateId) => dispatch({ type: "pickTemplate", id }), []);
  const onReset = useCallback(() => dispatch({ type: "pickTemplate", id: "agent" }), []);
  const onPickerChange = useCallback(
    (grants: PickerGrant[]) => dispatch({ type: "pickerChange", grants }),
    [],
  );
  const onCreateChange = useCallback((on: boolean) => dispatch({ type: "setCreate", on }), []);
  const onReadOnly = useCallback((on: boolean) => dispatch({ type: "setReadOnly", on }), []);
  const onRemove = useCallback(
    (resourceType: ResourceType, resourceId: string) =>
      dispatch({ type: "removeGrant", resourceType, resourceId }),
    [],
  );
  const onRemoveType = useCallback(
    (resourceType: ResourceType) => dispatch({ type: "removeType", resourceType }),
    [],
  );

  if (isPending) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  // Not signed in. The bounce lives in an effect (never in render — a
  // render-phase router.replace re-fires on every render pass) and only on the
  // FIRST arrival; coming back from /login still empty means the two session
  // views disagree, so we stop and ask rather than ping-pong. See RETRY_PARAM.
  if (!session) {
    return <SignInPrompt alreadyTried={searchParams.get(RETRY_PARAM) === "1"} />;
  }

  if (!clientId) {
    return (
      <div className="flex items-start gap-2 rounded-xl border border-danger-border bg-danger-bg p-4 text-sm text-danger">
        <AlertCircle className="mt-0.5 size-4 shrink-0" />
        {m.missingClientId}
      </div>
    );
  }

  const scoped = !isUnscopedTemplate(selection.template);

  // The org lives in the header next to the account: it's identity, and it's what
  // bounds every grant below. A single-org user gets a plain chip (nothing to
  // choose); a multi-org user gets the same chip as a click-to-switch menu.
  const orgLogo = activeOrg?.logo ? (
    // eslint-disable-next-line @next/next/no-img-element -- remote logo, no loader configured
    <img src={activeOrg.logo} alt="" aria-hidden className="size-4 shrink-0 rounded bg-muted object-cover" />
  ) : (
    <span
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center rounded bg-muted/60 text-[8px] font-semibold uppercase text-muted-foreground"
    >
      {orgName.slice(0, 2)}
    </span>
  );

  const orgChip =
    orgs.length > 1 ? (
      <DropdownMenu
        align="left"
        disabled={busy}
        actions={orgs.map((o) => ({
          id: o.id,
          label: o.name,
          icon: o.id === orgId ? <Check className="size-3.5" /> : undefined,
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
              <Loader2 className="size-3 shrink-0 animate-spin" />
            ) : (
              <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
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

  const summary = (
    <ScopeSummary
      selection={selection}
      orgName={orgName}
      labels={labels}
      disabled={busy}
      onRemove={onRemove}
      onRemoveType={onRemoveType}
      onReadOnly={onReadOnly}
    />
  );

  return (
    <>
      {/* Header spans both columns — it's the question being asked. The identity
          used to be a card of its own below this; it was three lines of chrome
          for no interaction, so it's a single meta line here instead. */}
      <div className="mb-6 flex items-start gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-success-bg text-success">
          <Boxes className="size-5" />
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

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-[1fr_380px]">
        {/* ── Left: what the client gets to do ── */}
        <div className="min-w-0 space-y-5">
          <TemplatePicker
            active={selection.template}
            orgName={orgName}
            disabled={busy}
            onPick={onPickTemplate}
            onReset={onReset}
          />

          {/* The editor only exists for a scoped template — the unscoped ones
              have nothing to list, so rendering it would be a dead panel. */}
          {scoped && (
            <ScopeEditor
              selection={selection}
              availableTypes={availableTypes}
              orgKey={orgId ?? "none"}
              disabled={busy}
              onPickerChange={onPickerChange}
              onCreateChange={onCreateChange}
            />
          )}
        </div>

        {/* ── Right: the summary + the decision ──
            Capped to the viewport on lg so the buttons below RailScroll are always
            on screen; plain stacked flow below lg, where the fixed bar takes over. */}
        <div className="space-y-4 lg:sticky lg:top-6 lg:flex lg:max-h-[calc(100dvh-3rem)] lg:flex-col lg:gap-4 lg:space-y-0 lg:self-start">
          <RailScroll>
            {summary}

            {rejected && (
              <div className="rounded-xl border border-warning-border bg-warning-bg p-3.5 text-xs text-warning">
                <p className="flex items-start gap-2 font-medium">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  {m.grantRejectedTitle}
                </p>
                <p className="mt-1 ps-5 leading-relaxed">
                  {interpolate(m.grantRejected, { resource: rejected })}
                </p>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-xl border border-danger-border bg-danger-bg p-3.5 text-sm text-danger">
                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                {error}
              </div>
            )}
          </RailScroll>

          <ActionBar
            variant="rail"
            busy={busy}
            submitting={submitting}
            canAuthorize={canAuthorize}
            onDeny={() => act(false)}
            onAuthorize={() => act(true)}
          />
        </div>
      </div>

      {/* Below lg the decision lives in a fixed bar; this keeps the last card
          clear of it. */}
      <div className="h-20 lg:hidden" aria-hidden />
      <ActionBar
        variant="fixed"
        busy={busy}
        submitting={submitting}
        canAuthorize={canAuthorize}
        onDeny={() => act(false)}
        onAuthorize={() => act(true)}
      />
    </>
  );
}

/**
 * Signed-out state. On first arrival it redirects itself to /login once (in an
 * effect, so it can't re-fire per render); if we're already back from /login and
 * still have no client session, it stops and shows the link instead — the only
 * way to guarantee this can't become a redirect loop.
 */
function SignInPrompt({ alreadyTried }: { alreadyTried: boolean }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { t } = useI18n();
  const m = t.misc.mcpAuthorize;
  const href = buildLoginHref(new URLSearchParams(searchParams.toString()));

  useEffect(() => {
    if (alreadyTried) return;
    router.replace(href);
  }, [alreadyTried, href, router]);

  if (!alreadyTried) {
    return (
      <div className="flex items-center justify-center py-10 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-md text-center">
      <div className="mx-auto mb-4 flex size-11 items-center justify-center rounded-2xl bg-warning-bg text-warning">
        <AlertCircle className="size-5" />
      </div>
      <h1 className="text-lg font-semibold text-foreground">{m.signInRequiredTitle}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{m.signInRequiredBody}</p>
      <a
        href={href}
        className="mt-4 inline-flex items-center justify-center rounded-xl bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
      >
        {m.signInAction}
      </a>
    </div>
  );
}

export default function McpAuthorizePage() {
  return (
    // `align="start"`: this page is taller than the viewport, and AuthShell's
    // default vertical centering would push its top above the scroll origin and
    // break the sticky rail.
    <AuthShell maxWidth="max-w-6xl" align="start">
      <Suspense
        fallback={
          <div className="flex items-center justify-center py-10 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        }
      >
        <McpAuthorizeInner />
      </Suspense>
    </AuthShell>
  );
}
