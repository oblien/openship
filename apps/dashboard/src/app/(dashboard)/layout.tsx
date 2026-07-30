import { redirect } from "next/navigation";
import { getSession, getDeploymentInfoOrNull } from "@/lib/server/session";
import { ApiUnavailable } from "@/components/api-unavailable";
import { Sidebar } from "@/components/sidebar";
import { UpdateCenter } from "@/components/updates/UpdateCenter";
import { MigratedLauncher } from "@/components/migrated-launcher";
import { MigrationInProgress } from "@/components/migration-in-progress";
import { DashboardProviders } from "./providers";
import { serverApi, ServerApiError } from "@/lib/server/api";

/**
 * Better Auth's organization plugin returns `{ data: Org[] }` from
 * GET /api/auth/organization/list — the user's full org membership.
 * We only need the id here to decide between auto-pick and chooser.
 */
type OrgListItem = { id: string };
type OrgListResponse = { data?: OrgListItem[] } | OrgListItem[] | null;

async function fetchUserOrgs(): Promise<OrgListItem[]> {
  try {
    const res = await serverApi.get<OrgListResponse>(
      "auth/organization/list",
      { cache: "no-store" },
    );
    if (!res) return [];
    if (Array.isArray(res)) return res;
    return res.data ?? [];
  } catch (err) {
    // 401/404 here means the org plugin can't enumerate — fall back to
    // "single org" semantics (no chooser, no auto-set). Never block
    // the dashboard on a probe failure.
    if (err instanceof ServerApiError) return [];
    return [];
  }
}

/**
 * Resolve the org chooser gate for a freshly authenticated session.
 *
 *  - 2+ orgs and no explicit active selection → /select-organization
 *  - exactly 1 org and no active selection    → auto-set server-side,
 *                                                then continue rendering
 *  - active selection already set             → no-op
 *
 * The session.create.before hook in apps/api/src/lib/auth.ts defaults
 * activeOrganizationId to the user's deterministic personal org for
 * every Better Auth-minted session, so in practice the "no selection"
 * branch only fires for legacy rows or sessions whose active org has
 * been cleared. The auto-set path goes through Better Auth's set-active
 * endpoint so the response Set-Cookie (which serverApi forwards back to
 * the browser) carries the updated session.
 */
async function resolveOrgChooserGate(
  activeOrganizationId: string | null | undefined,
): Promise<{ redirectTo?: string }> {
  const orgs = await fetchUserOrgs();
  // Trust the session's active org ONLY if it's an actual membership. A
  // stale/foreign active org — e.g. the zero-auth Local User's workspace
  // carried into a cloud user's session after cloud-connect — would otherwise
  // scope the whole UI (Team members, cloud status, everything) to an org the
  // user isn't in. Reconcile to a real membership instead.
  if (activeOrganizationId && orgs.some((o) => o.id === activeOrganizationId)) return {};
  if (orgs.length >= 2) {
    return { redirectTo: "/select-organization" };
  }
  if (orgs.length === 1) {
    try {
      await serverApi.post("auth/organization/set-active", {
        organizationId: orgs[0].id,
      });
    } catch {
      // Couldn't auto-set — render the dashboard anyway; the api-side
      // resolveActiveOrganizationId fallback will pick the membership
      // for org-scoped queries.
    }
  }
  return {};
}

/**
 * Dashboard shell layout - sidebar + main area.
 * Session is validated server-side before rendering.
 *
 * Boot gate: if this instance has been migrated to a multi-user
 * deployment (teamMode !== "single_user"), short-circuit to the
 * launcher screen — the real data lives at migrationTargetUrl.
 * We still require a valid session so a stranger can't see the
 * migrated-instance URL.
 */
export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");

  // Org chooser gate. If the session has no explicit activeOrganizationId
  // and the user belongs to 2+ orgs, send them to /select-organization;
  // single-org users get the only one auto-set server-side. Runs BEFORE
  // the migration / teamMode gates because those are configured per-org
  // and reading them with the wrong active org would mis-route.
  const { redirectTo } = await resolveOrgChooserGate(
    session.session.activeOrganizationId,
  );
  if (redirectTo) redirect(redirectTo);

  // Layout MUST see fresh `migrationInProgress` to route correctly during
  // the cutover window — the lock flips faster than the deploy-info cache
  // TTL (30s in prod), so a cached `false` during a fresh migration would
  // render the normal UI (writes would 503), and a cached `true` after the
  // lock releases would trap the operator on the in-progress launcher.
  // Other callers can keep using the cache.
  const deploymentInfo = await getDeploymentInfoOrNull({ skipCache: true });
  if (!deploymentInfo) return <ApiUnavailable />;

  // Mid-flight migration gate. The DB is being cut over — rendering
  // the normal UI would risk a 503'd write, and rendering the
  // MigratedLauncher would falsely imply the migration is done. The
  // in-progress launcher polls /api/health/env and reloads once
  // migrationInProgress flips back to false. Checked BEFORE the
  // teamMode gate so we don't latch onto a half-written teamMode
  // mid-cutover (the lock is the source of truth here).
  if (deploymentInfo.migrationInProgress) {
    return <MigrationInProgress />;
  }

  // Migrated-instance gate. The dashboard exists ONLY as a launcher
  // here — sidebar + project list + everything else lives on the
  // remote. The "switch back" escape hatch is in the launcher itself.
  if (
    deploymentInfo.teamMode &&
    deploymentInfo.teamMode !== "single_user" &&
    deploymentInfo.migrationTargetUrl
  ) {
    return (
      <MigratedLauncher
        teamMode={deploymentInfo.teamMode}
        migrationTargetUrl={deploymentInfo.migrationTargetUrl}
      />
    );
  }

  const initialGithubData = await serverApi
    .get("github/home", { cache: "no-store" })
    .catch(() => null);

  return (
    <DashboardProviders
      initialGithubData={initialGithubData}
      initialUser={session.user}
      selfHosted={deploymentInfo.selfHosted}
      deployMode={deploymentInfo.deployMode}
      isServerHost={deploymentInfo.isServerHost}
      authMode={deploymentInfo.authMode}
      cloudAuthUrl={deploymentInfo.cloudAuthUrl}
      cloudApiUrl={deploymentInfo.cloudApiUrl}
      machineName={deploymentInfo.machineName}
      hostDomain={deploymentInfo.hostDomain}
    >
      <div className="flex flex-col h-dvh">
        {/* Update + platform-status surface — full app width, ABOVE the sidebar.
            Renders nothing unless there's an advisory / platform notice (SaaS:
            partial outage, maintenance) / available update / what's-new, so it
            adds no chrome when idle. */}
        <UpdateCenter />
        <div className="flex flex-1 min-h-0">
          <Sidebar />
          {/* Main content */}
          <main className="flex-1 overflow-y-auto">{children}</main>
        </div>
      </div>
    </DashboardProviders>
  );
}
