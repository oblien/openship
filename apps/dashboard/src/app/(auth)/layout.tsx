import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession, getDeploymentInfoOrNull, needsOrgSelection } from "@/lib/server/session";
import { ApiUnavailable } from "@/components/api-unavailable";
import {
  getCloudConnectHandoffUrl,
  buildAuthPageHref,
  validateReturnTo,
  DESKTOP_CLOUD_FLOW,
} from "@/lib/cloud-auth";
import { AuthProviders } from "./providers";

/**
 * Auth layout - minimal shell, no sidebar. Sends already-authenticated
 * users away from the login form:
 *   - With `?callback=`  → forward to the cloud-connect handoff (or
 *                          `/authorize` for the desktop flow). A blind
 *                          `redirect("/")` would silently drop the
 *                          callback and break local→cloud connect for
 *                          users with a live SaaS session.
 *   - Without `?callback=` → home.
 */
export default async function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Only redirect away from /login if the BROWSER has a real session
  // cookie. In desktop zero-auth mode the api auto-provisions a
  // session and sets the cookie on its OWN response (server-to-server
  // hop) — the browser never receives it, so server-side getSession
  // returning truthy doesn't mean the user is actually logged in here.
  // Without this gate we hit the classic redirect loop:
  //   / → proxy.ts (no cookie) → /login → layout (session truthy) →
  //   redirect("/") → /  → loop.
  const hdrs = await headers();
  const cookieHeader = hdrs.get("cookie") ?? "";
  const hasBrowserSession = /\.session_token=/.test(cookieHeader);

  const session = hasBrowserSession ? await getSession() : null;

  if (session) {
    // proxy.ts (middleware) stamps the original pathname+search onto
    // a request header — that header is set server-side AFTER the
    // middleware overrides whatever the client may have sent, so it's
    // safe to trust. Falling back to `Referer` would be client-
    // controlled and could leak a cross-origin callback into our
    // redirect chain.
    const pathWithSearch = hdrs.get("x-pathname-with-search") ?? "";
    const query = pathWithSearch.includes("?")
      ? pathWithSearch.slice(pathWithSearch.indexOf("?"))
      : "";
    const params = new URLSearchParams(query);
    const callback = params.get("callback");

    // returnTo wins over callback when both are present — it's the
    // explicit "come back to this page after login" signal used by
    // /cloud-authorize. validateReturnTo enforces the safe-path allowlist
    // server-side so a tampered URL can't redirect to an attacker domain.
    const returnTo = validateReturnTo(params.get("returnTo"));
    if (returnTo) {
      redirect(returnTo);
    }

    if (callback) {
      if (params.get("flow") === DESKTOP_CLOUD_FLOW) {
        redirect(buildAuthPageHref("/authorize", params));
      }
      // PKCE: prefer the state+challenge already stamped on the incoming
      // URL by the SaaS `buildAuthHandoff` upstream — those values are
      // bound to a verifier the originating browser still holds, so the
      // callback can finish the exchange. We deliberately do NOT mint
      // fresh PKCE here: this layout runs server-side, can't reach
      // window.localStorage, and would just produce a verifier nobody
      // can later read. If the incoming URL has no PKCE the handoff
      // falls back to a bearer code — that gap stays until the upstream
      // login URL is guaranteed to carry PKCE in every flow.
      const incomingState = params.get("state");
      const incomingChallenge = params.get("code_challenge");
      redirect(
        getCloudConnectHandoffUrl(
          callback,
          incomingState && incomingChallenge
            ? { state: incomingState, codeChallenge: incomingChallenge }
            : undefined,
        ),
      );
    }

    // Don't bounce a logged-in user home if they still need to pick an org:
    // /select-organization lives in THIS group and the dashboard sends them
    // here for exactly that. Redirecting to "/" would just loop back. When a
    // choice is pending, fall through and render the page instead.
    if (!(await needsOrgSelection(session.session.activeOrganizationId))) {
      redirect("/");
    }
  }

  const deploymentInfo = await getDeploymentInfoOrNull();
  if (!deploymentInfo) return <ApiUnavailable />;

  return (
    <AuthProviders
      authMode={deploymentInfo.authMode}
      cloudAuthUrl={deploymentInfo.cloudAuthUrl}
      selfHosted={deploymentInfo.selfHosted}
      bootstrapRequired={Boolean(deploymentInfo.bootstrapRequired)}
    >
      <div className="th-page">{children}</div>
    </AuthProviders>
  );
}
